'use strict';

// lib/imageCompressor.js — native-ffmpeg image compression, mirroring
// lib/videoCompressor.js's shape so importcompressedbulk.js can call either compressor
// through the same interface (probe / compress / extractThumbnail).
//
// Uses ffmpeg rather than a separate image library (sharp/libvips, etc.) on
// purpose: ffmpeg is already a hard dependency for video, so this avoids
// adding a second native-compiled dependency just for images.
//
// Output format is chosen at runtime, not hardcoded, because libwebp is an
// *optional* ffmpeg build flag, not a given — confirmed the hard way:
// Homebrew's own `ffmpeg` formula on macOS ships without it (no `webp`
// dependency in `brew deps ffmpeg`), while most Debian/Ubuntu apt packages
// do include it. So:
//   - libwebp available -> WebP for everything (best compression, alpha,
//     animation support).
//   - not available, source has no alpha -> MJPEG (near-universal, lossy,
//     small).
//   - not available, source may have alpha (.png/.webp) -> PNG (lossless,
//     always built in, keeps transparency correct over silently discarding
//     it).
//   - not available, animated -> GIF (ffmpeg's native encoder, no external
//     lib needed, keeps the animation instead of collapsing it to one frame).
// Capability is probed once per ffmpeg binary and cached — see
// getCapabilities() — so this costs one extra spawn per run, not per file.
// compress()/extractThumbnail() return the *actual* output path used, since
// the extension depends on which of these was picked; callers must use the
// returned path rather than assume the one they requested.
//
// Pure functions only: no CLI parsing, no process.exit(), no console
// output — see lib/videoCompressor.js's header comment for the rationale.

const path = require('path');
const { spawn } = require('child_process');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

// Extensions that can plausibly be animated. Anything else skips the extra
// -count_frames probe pass below (slow — it fully decodes the file).
// NOTE: animated PNG (APNG) is not detected here and will be compressed as
// a static image, losing its animation. Flag this to callers if APNG shows
// up in real uploads; not expected from the current mobile capture flow.
const POSSIBLY_ANIMATED_EXTENSIONS = new Set(['.gif', '.webp']);

// ffmpeg/ffprobe always print a ~10-line version/build-config/library-
// version banner to stderr before anything else, regardless of whether the
// call fails. `-hide_banner` (added at every call site below) stops it at
// the source; this is a second, defensive pass over whatever stderr shows
// up anyway (a caller that forgets the flag, or an unexpected ffmpeg
// build), so an error message is never mostly boilerplate someone has to
// scroll past to find the one line that matters.
function cleanStderr(stderr) {
  return stderr
    .split('\n')
    .filter((line) => !/^ffmpeg version |^ {2}(built with|configuration:|lib(avutil|avcodec|avformat|avdevice|avfilter|swscale|swresample|postproc)\s)/.test(line))
    .join('\n')
    .trim();
}

// Renders argv back into a copy-pasteable command line for error messages -
// informational only (naive whitespace quoting, not real shell escaping).
function formatCommand(bin, args) {
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  return [bin, ...quoted].join(' ');
}

function runCommand(bin, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(`'${bin}' not found on PATH — install ffmpeg or set FFMPEG_PATH/FFPROBE_PATH`));
      } else {
        reject(err);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`timed out after ${timeoutMs}ms running: ${formatCommand(bin, args)}`));
      } else if (code !== 0) {
        const cleaned = cleanStderr(stderr).slice(-2000);
        reject(new Error(`exit ${code} running: ${formatCommand(bin, args)}${cleaned ? `\n${cleaned}` : ''}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function checkBinaries({ ffmpegBin = 'ffmpeg', ffprobeBin = 'ffprobe', timeoutMs = 15000 } = {}) {
  for (const bin of [ffmpegBin, ffprobeBin]) {
    await runCommand(bin, ['-version'], { timeoutMs });
  }
}

// Cached per ffmpeg binary path so a bulk run only probes this once, not
// once per file. `ffmpeg -h encoder=<name>` always exits 0 whether or not
// the encoder exists — the only signal is the message text on stdout.
const capabilityCache = new Map();

async function getCapabilities(ffmpegBin, timeoutMs) {
  if (!capabilityCache.has(ffmpegBin)) {
    capabilityCache.set(ffmpegBin, detectWebpSupport(ffmpegBin, timeoutMs));
  }
  return capabilityCache.get(ffmpegBin);
}

async function detectWebpSupport(ffmpegBin, timeoutMs) {
  try {
    const { stdout } = await runCommand(ffmpegBin, ['-hide_banner', '-h', 'encoder=libwebp'], { timeoutMs: timeoutMs || 15000 });
    return { webp: /^Encoder libwebp/m.test(stdout.toString()) };
  } catch (err) {
    return { webp: false };
  }
}

/**
 * Probes an image for dimensions + a best-effort animation check.
 * Throws if no image/video stream is found (ffprobe reports still images
 * under codec_type "video").
 */
async function probe(filePath, { ffprobeBin = 'ffprobe', timeoutMs = 15000 } = {}) {
  const { stdout } = await runCommand(
    ffprobeBin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs }
  );

  let data;
  try {
    data = JSON.parse(stdout.toString());
  } catch (err) {
    throw new Error(`ffprobe returned non-JSON output: ${err.message}`);
  }

  const stream = (data.streams || []).find((s) => s.codec_type === 'video');
  if (!stream) {
    const found = (data.streams || []).map((s) => s.codec_type).join(', ');
    throw new Error(`no image stream found (${found ? `file has: ${found}` : 'file has no streams at all'})`);
  }

  let isAnimated = false;
  const ext = path.extname(filePath).toLowerCase();
  if (POSSIBLY_ANIMATED_EXTENSIONS.has(ext)) {
    // Frame count is unreliable without a full decode for gif/webp — do the
    // decode explicitly rather than guess. Fine for images (small/fast);
    // would be far too slow to do this for video.
    try {
      const { stdout: countOut } = await runCommand(
        ffprobeBin,
        ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-print_format', 'json', filePath],
        { timeoutMs: Math.max(timeoutMs, 30000) }
      );
      const countData = JSON.parse(countOut.toString());
      const nbFrames = parseInt(countData.streams && countData.streams[0] && countData.streams[0].nb_read_frames, 10);
      isAnimated = Number.isFinite(nbFrames) && nbFrames > 1;
    } catch (err) {
      isAnimated = false; // best-effort; treat as static if counting fails
    }
  }

  return {
    width: stream.width,
    height: stream.height,
    codec: stream.codec_name,
    isAnimated,
    formatBytes: parseInt(data.format && data.format.size, 10) || null,
  };
}

// Extensions whose source pixels might carry an alpha channel. Used only to
// pick a safe *fallback* encoder when libwebp is unavailable — JPEG/BMP/TIFF
// sources are treated as opaque, PNG/WebP sources are treated as possibly
// transparent so a fallback never silently flattens transparency to black.
const POSSIBLY_ALPHA_EXTENSIONS = new Set(['.png', '.webp']);

function pickCodec(inputPath, probeInfo, caps) {
  if (caps.webp) return { codec: 'libwebp', ext: '.webp' };
  if (probeInfo.isAnimated) return { codec: 'gif', ext: '.gif' }; // always built in, no external lib
  const mayHaveAlpha = POSSIBLY_ALPHA_EXTENSIONS.has(path.extname(inputPath).toLowerCase());
  return mayHaveAlpha ? { codec: 'png', ext: '.png' } : { codec: 'mjpeg', ext: '.jpg' };
}

function buildEncodeArgs(inputPath, outputPath, probeInfo, opts) {
  const args = ['-hide_banner', '-y', '-i', inputPath];

  // Strips EXIF (including GPS location tags) before the file is published
  // to IPFS — a privacy default, not just a size one.
  args.push('-map_metadata', '-1');

  if (probeInfo.isAnimated) {
    args.push('-loop', '0');
  } else {
    args.push('-frames:v', '1');
  }

  if (opts.maxDim) {
    // min(iw, maxDim) never exceeds the source, so this only ever downscales.
    args.push('-vf', `scale='min(iw,${opts.maxDim})':'min(ih,${opts.maxDim})':force_original_aspect_ratio=decrease`);
  }

  const quality = opts.quality != null ? opts.quality : 80;
  if (opts.codec === 'libwebp') {
    args.push('-c:v', 'libwebp', '-lossless', '0', '-q:v', String(quality));
  } else if (opts.codec === 'gif') {
    args.push('-c:v', 'gif');
  } else if (opts.codec === 'png') {
    args.push('-c:v', 'png');
  } else {
    // mjpeg: map 0 (worst) - 100 (best) "quality" onto ffmpeg's qscale,
    // where 2 is best and 31 is worst.
    const qscale = Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
    args.push('-c:v', 'mjpeg', '-q:v', String(qscale));
  }

  args.push('-an', outputPath);

  return args;
}

/**
 * Encodes inputPath -> outputPath, animated or static per probeInfo.isAnimated.
 * Picks WebP when the ffmpeg build supports it, otherwise a safe fallback
 * (see pickCodec above) — so the *requested* outputPath's extension may not
 * match what's actually written. Returns { outputPath, codec } with the
 * path actually used; callers must use that, not the one they passed in.
 * opts: { ffmpegBin, timeoutMs, quality, maxDim }
 */
async function compress(inputPath, outputPath, probeInfo, opts = {}) {
  const ffmpegBin = opts.ffmpegBin || 'ffmpeg';
  const caps = await getCapabilities(ffmpegBin, opts.timeoutMs);
  const { codec, ext } = pickCodec(inputPath, probeInfo, caps);
  const finalOutputPath = outputPath.replace(/\.[^./\\]+$/, ext);

  await runCommand(ffmpegBin, buildEncodeArgs(inputPath, finalOutputPath, probeInfo, { ...opts, codec }), {
    timeoutMs: opts.timeoutMs || 60000,
  });

  return { outputPath: finalOutputPath, codec };
}

/**
 * Same encode path as compress(), just defaulting to a much smaller max
 * dimension and lower quality — a feed-thumbnail-sized variant rather than
 * a distinct code path. Returns { outputPath, codec } like compress().
 * opts: { ffmpegBin, timeoutMs, quality, maxDim }
 */
async function extractThumbnail(inputPath, thumbPath, probeInfo, opts = {}) {
  return compress(inputPath, thumbPath, probeInfo, {
    ffmpegBin: opts.ffmpegBin,
    timeoutMs: opts.timeoutMs || 30000,
    quality: opts.quality != null ? opts.quality : 60,
    maxDim: opts.maxDim || 320,
  });
}

module.exports = {
  IMAGE_EXTENSIONS,
  checkBinaries,
  probe,
  compress,
  extractThumbnail,
};
