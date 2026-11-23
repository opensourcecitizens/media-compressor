'use strict';

// lib/videoCompressor.js — native-ffmpeg video compression, extracted from
// examplecompressbulk.js so both examplecompressbulk.js (video-only) and importcompressedbulk.js
// (mixed image/video) share one implementation instead of two copies that
// can drift apart.
//
// Pure functions only: no CLI arg parsing, no process.exit(), no console
// output beyond what the caller chooses to do with thrown errors. Every
// tunable (binary paths, crf, preset, timeouts, ...) is passed in via an
// options object so this file is usable standalone (unit tests, other
// scripts) as well as from a CLI wrapper.

const fs = require('fs');
const { spawn } = require('child_process');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.wmv', '.mpg', '.mpeg',
]);

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

function runCommand(bin, args, { timeoutMs = 600000 } = {}) {
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

/**
 * Confirms both binaries are runnable. Throws with an install hint rather
 * than exiting — callers decide how a preflight failure should surface.
 */
async function checkBinaries({ ffmpegBin = 'ffmpeg', ffprobeBin = 'ffprobe', timeoutMs = 15000 } = {}) {
  for (const bin of [ffmpegBin, ffprobeBin]) {
    await runCommand(bin, ['-version'], { timeoutMs });
  }
}

/**
 * Probes a video file for the fields the compressor / duration gate need.
 * Throws if the file has no video stream or duration can't be determined.
 */
async function probe(filePath, { ffprobeBin = 'ffprobe', timeoutMs = 30000 } = {}) {
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

  const videoStream = (data.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (data.streams || []).find((s) => s.codec_type === 'audio');
  if (!videoStream) {
    const found = (data.streams || []).map((s) => s.codec_type).join(', ');
    throw new Error(`no video stream found (${found ? `file has: ${found}` : 'file has no streams at all'})`);
  }

  let durationSec = parseFloat(data.format && data.format.duration);
  if (!Number.isFinite(durationSec)) durationSec = parseFloat(videoStream.duration);
  if (!Number.isFinite(durationSec)) {
    throw new Error(
      `could not determine duration (format.duration=${JSON.stringify(data.format && data.format.duration)}, ` +
      `stream.duration=${JSON.stringify(videoStream.duration)}, format=${data.format && data.format.format_name})`
    );
  }

  return {
    durationSec,
    width: videoStream.width,
    height: videoStream.height,
    videoCodec: videoStream.codec_name,
    hasAudio: Boolean(audioStream),
    formatBytes: parseInt(data.format && data.format.size, 10) || null,
  };
}

function buildEncodeArgs(inputPath, outputPath, probeInfo, opts) {
  const args = ['-hide_banner', '-y', '-i', inputPath];

  // Best-effort determinism: strip metadata that varies run-to-run
  // (encode timestamps, creation dates) so re-encoding an unchanged source
  // tends to produce the same bytes -> the same IPFS CID, avoiding
  // duplicate pins of identical content. libx264 is only bit-exact across
  // runs with a fixed thread count, hence opts.deterministic below.
  args.push('-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact');

  if (opts.deterministic) args.push('-threads', '1');

  if (opts.maxHeight && probeInfo.height > opts.maxHeight) {
    args.push('-vf', `scale=-2:${opts.maxHeight}`);
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', opts.preset || 'slow',
    '-crf', String(opts.crf != null ? opts.crf : 22),
    '-profile:v', 'high',
    '-level', '4.0',
    '-pix_fmt', 'yuv420p'
  );

  if (probeInfo.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000');
  else args.push('-an');

  // Moves the moov atom to the front so playback from an IPFS gateway can
  // start before the whole object has downloaded.
  args.push('-movflags', '+faststart', '-f', 'mp4', outputPath);

  return args;
}

/**
 * Encodes inputPath -> outputPath (always .mp4). probeInfo must come from
 * probe() — height/hasAudio drive the scale filter and audio codec choice.
 * opts: { ffmpegBin, timeoutMs, crf, preset, maxHeight, deterministic }
 */
async function compress(inputPath, outputPath, probeInfo, opts = {}) {
  console.log('compress called ...')
  await runCommand(opts.ffmpegBin || 'ffmpeg', buildEncodeArgs(inputPath, outputPath, probeInfo, opts), {
    timeoutMs: opts.timeoutMs || 600000,
  });
}

/**
 * Extracts a single JPEG poster frame at ~10% into the video.
 * opts: { ffmpegBin, timeoutMs }
 */
async function extractThumbnail(inputPath, thumbPath, durationSec, opts = {}) {
  const seekAt = Math.max(0, Math.min(durationSec * 0.1, Math.max(0, durationSec - 0.1)));
  await runCommand(
    opts.ffmpegBin || 'ffmpeg',
    ['-hide_banner', '-y', '-ss', seekAt.toFixed(2), '-i', inputPath, '-frames:v', '1', '-q:v', '4', thumbPath],
    { timeoutMs: opts.timeoutMs || 30000 }
  );
}

module.exports = {
  VIDEO_EXTENSIONS,
  checkBinaries,
  probe,
  compress,
  extractThumbnail,
};
