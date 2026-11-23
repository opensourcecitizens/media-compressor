'use strict';

// lib/browser/videoCompressor.js — client-side video compression via
// ffmpeg.wasm. Unlike images (see imageCompressor.js), a browser has no
// native way to re-encode video — this is genuinely the same library the
// original (now-replaced) mp4video_ffmpeg_compression.js sketch reached
// for, done with the current API and sane settings this time (that sketch
// used `-crf 0`, which is *larger* than the source and often undecodable
// on iOS/Safari; see examplecompressbulk.js's header for the full
// writeup). ffmpeg itself isn't available as a native binary in a browser
// the way lib/videoCompressor.js (the Node bulk-import path) can shell out
// to it — this is the WASM build of the same encoder, run in a Worker.
//
// Real cost of that: ~30MB of WASM downloaded (once — cached across calls
// in this page's lifetime, not per file) and native-slow, single-threaded
// x264 encoding on the uploader's own device. That's why `probe()` below
// deliberately does NOT use ffmpeg.wasm at all — a native <video> element
// already gives duration/dimensions for free, so the 30s cap
// examplecompressbulk.js/importcompressedbulk.js enforce server-side can
// be checked, and a too-long upload rejected, *before* ever paying to load
// ffmpeg.wasm.
//
// CDN + global names below were confirmed against the live npm registry
// and unpkg's actual file listing while building this, not assumed from
// memory — @ffmpeg/ffmpeg's UMD build assigns `window.FFmpegWASM.FFmpeg`,
// @ffmpeg/util's assigns `window.FFmpegUtil.{fetchFile, toBlobURL}`. If
// you bump these versions, re-check both — UMD global names are not part
// of any semver contract.
//
// Plain <script src> global (window.BrowserVideoCompressor) — see
// mediaDetect.js's header for why there's no module system in this
// directory.

(function (global) {
  // @ffmpeg/ffmpeg is pinned to 0.12.10 specifically, not just "whatever's
  // current" - this matters here. Its worker chunk (814.ffmpeg.js below)
  // tries `importScripts(coreURL)` first and falls back to a dynamic
  // `import(coreURL)` if that throws, which it always does inside a module
  // worker (spec behavior, confirmed via MDN - not origin-dependent, so
  // self-hosting these files instead of using a CDN would NOT avoid this).
  // In 0.12.11+ (checked up through 0.12.15) and in 0.12.7-0.12.9, that
  // fallback is bundled as webpack's auto-generated stub for an
  // unresolvable dynamic require - a dead function that unconditionally
  // throws `Error("Cannot find module '"+url+"'")` no matter what URL you
  // give it. That's the exact, literal source of a
  // "Cannot find module 'blob:...'" error from inside ffmpeg.load().
  // 0.12.10's build is the one confirmed (by diffing the actual fetched
  // chunk content, not assumed) to still bundle a real, working
  // `await import(r)` in that fallback path instead of the broken stub -
  // matches the @ffmpeg/core version already pinned below. Re-verify this
  // exact regression before bumping either version.
  const FFMPEG_JS_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js';
  const FFMPEG_UTIL_URL = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js';
  // Must be the `esm` build, not `umd`, despite everything else here being
  // UMD - confirmed by diffing both: dist/umd/ffmpeg-core.js is a plain
  // script (`var createFFmpegCore = ...`), zero `export` statements; only
  // dist/esm/ffmpeg-core.js ends with `export default createFFmpegCore`.
  // The worker's fallback loader (see 814.ffmpeg.js's note above) grabs
  // the core via a real dynamic `import(coreURL)`, which needs an actual
  // ES module - importing the UMD build "succeeds" (it's syntactically
  // valid JS either way) but yields an empty module namespace, so
  // `.default` comes back undefined and it throws
  // "failed to import ffmpeg-core.js". Matches what the worker's own code
  // does by default (it swaps "/umd/" for "/esm/" on its fallback URL
  // when no coreURL is given at all) - passing an explicit coreURL skips
  // that swap, so it has to be pre-pointed at esm here instead.
  const FFMPEG_CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
  // Worker chunk id (814) is webpack's internal numeric chunk id, not part
  // of any semver contract, but has been stable across every 0.12.x build
  // checked while diagnosing this. See getFfmpeg() below for why this
  // needs to be loaded as a blob: URL (classWorkerURL) at all - separate
  // issue (cross-origin Worker construction) from the one above.
  const FFMPEG_WORKER_URL = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js';

  function loadScriptOnce(src, type) {
    return new Promise((resolve, reject) => {
      // NOTE: do not set window.exports (or window.module) here. Both
      // @ffmpeg/ffmpeg's and @ffmpeg/util's UMD builds branch on
      // `typeof exports === "object"` to decide whether they're in a
      // CommonJS environment; in a plain <script src> browser load that's
      // "undefined", so they correctly fall through to assigning the
      // global (window.FFmpegWASM / window.FFmpegUtil). Pre-defining
      // window.exports = {} makes that check true and diverts them into
      // setting window.exports.FFmpegWASM / .FFmpegUtil instead — the
      // exact cause of "Cannot read properties of undefined (reading
      // 'FFmpeg')" a few lines below. Don't reintroduce it.
      //
      // Also don't load either file as `<script type="module">` — both
      // are plain UMD bundles (verified against the actual published
      // files, not ES modules with `export` statements), so a module
      // script tag changes how they're parsed/executed for no benefit.
      const existing = document.querySelector(`script[data-ffmpeg-loader="${src}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error(`failed to load ${src}`)));
        return;
      }
      const el = document.createElement('script');
      el.src = src;
      if(type != null) el.type = type;
      el.setAttribute('data-ffmpeg-loader', src);
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(el);
    });
  }

  // Loaded (or in-flight) at most once per page load, not once per file -
  // this is the ~30MB-download cost, paid once regardless of how many
  // videos get compressed in this session.
  let ffmpegPromise = null;

  function getFfmpeg() {
    if (!ffmpegPromise) {
      ffmpegPromise = (async () => {
        if (!global.FFmpegWASM) await loadScriptOnce(FFMPEG_JS_URL);
        if (!global.FFmpegUtil) await loadScriptOnce(FFMPEG_UTIL_URL);
        const FFmpeg = global.FFmpegWASM.FFmpeg;
        const toBlobURL = global.FFmpegUtil.toBlobURL;
        const ffmpeg = new FFmpeg();
        await ffmpeg.load({
          coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
          classWorkerURL: await toBlobURL(FFMPEG_WORKER_URL, 'text/javascript'),
        });
        //console.log('getFfmpeg ... loaded ffmpeg',ffmpeg);
        return ffmpeg;
      })().catch((err) => {
        console.error(err);
        ffmpegPromise = null; // let a retry actually retry instead of replaying the same failure forever
        throw err;
      });
    }
    return ffmpegPromise;
  }

  /**
   * Reads duration + dimensions via a native <video> element's metadata -
   * zero ffmpeg cost. Rejects on a corrupt/unsupported file rather than
   * hanging; always revokes its object URL.
   * Resolves { durationSec, width, height }.
   */
  function probe(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const videoEl = document.createElement('video');
      videoEl.preload = 'metadata';
      videoEl.muted = true;

      const cleanup = () => URL.revokeObjectURL(url);

      videoEl.onloadedmetadata = () => {
        const duration = videoEl.duration;
        cleanup();
        if (!Number.isFinite(duration)) {
          reject(new Error('could not determine duration (no metadata reported)'));
        } else {
          resolve({ durationSec: duration, width: videoEl.videoWidth, height: videoEl.videoHeight });
        }
      };
      videoEl.onerror = () => {
        cleanup();
        reject(new Error('could not read video metadata (corrupt or unsupported file)'));
      };
      videoEl.src = url;
    });
  }

  function guessInputExt(file) {
    const m = /\.[a-z0-9]+$/i.exec(file.name || '');
    return m ? m[0] : '.mp4';
  }

  /**
   * Re-encodes `file` to mp4 (libx264/aac, faststart) via ffmpeg.wasm.
   * Mirrors lib/videoCompressor.js's flags (crf/faststart/pix_fmt) with a
   * faster default preset — WASM x264 is far slower than the native
   * binary that library shells out to, and this runs on the uploader's
   * own device/tab rather than a bulk-import server that can afford to
   * wait. `-c:a aac` is always included regardless of whether the source
   * has audio — verified against real ffmpeg (not assumed): encoding a
   * silent input with `-c:a aac` present exits 0 and simply produces no
   * audio stream, it does not error.
   *
   * probeInfo: from probe() above — used only to decide whether to scale.
   * opts: { crf=23, preset='veryfast', maxHeight=1080, onLog(message) }
   * Returns { blob, mime, width, height, skipped, reason } — same shape as
   * imageCompressor.js's compress(), so callers don't need to branch on
   * media kind to read the result.
   */
  async function compress(file, probeInfo, opts) {
    opts = opts || {};
    const ffmpeg = await getFfmpeg();
    const fetchFile = global.FFmpegUtil.fetchFile;
    let removeLogListener = null;
    if (opts.onLog) {
      const handler = ({ message }) => opts.onLog(message);
      ffmpeg.on('log', handler);
      removeLogListener = () => ffmpeg.off('log', handler);
    }

    const inputName = 'input' + guessInputExt(file);
    const outputName = 'output.mp4';

    try {
      await ffmpeg.writeFile(inputName, await fetchFile(file));

      const args = ['-i', inputName, '-map_metadata', '-1'];
      if (opts.maxHeight && probeInfo && probeInfo.height > opts.maxHeight) {
        args.push('-vf', `scale=-2:${opts.maxHeight}`);
      }
      args.push(
        '-c:v', 'libx264',
        '-preset', opts.preset || 'veryfast',
        '-crf', String(opts.crf != null ? opts.crf : 23),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputName
      );

      const exitCode = await ffmpeg.exec(args);
      if (exitCode !== 0) throw new Error(`ffmpeg.wasm exited ${exitCode} — see console for the log if opts.onLog wasn't set`);

      const data = await ffmpeg.readFile(outputName);
      const compressedBlob = new Blob([data.buffer], { type: 'video/mp4' });

      // Never ship a file bigger than the source — same rule
      // imageCompressor.js applies, and lib/videoCompressor.js (the Node
      // bulk-import path) applies server-side. Returned in the same shape
      // as imageCompressor.js's compress() ({ blob, mime, width, height,
      // skipped, reason }) rather than a bare Blob, so callers can treat
      // either media kind identically.
      if (compressedBlob.size >= file.size) {
        return {
          blob: file,
          mime: file.type || null,
          width: probeInfo && probeInfo.width,
          height: probeInfo && probeInfo.height,
          skipped: true,
          reason: 'compressed-not-smaller',
        };
      }
      return {
        blob: compressedBlob,
        mime: 'video/mp4',
        width: probeInfo && probeInfo.width,
        height: probeInfo && probeInfo.height,
        skipped: false,
        reason: null,
      };
    } finally {
      if (removeLogListener) removeLogListener();
      // Best-effort cleanup of ffmpeg's virtual FS — a failure to delete
      // (e.g. writeFile itself never succeeded) shouldn't mask the real
      // error from the try block above.
      await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(outputName).catch(() => {});
    }
  }

  global.BrowserVideoCompressor = { probe: probe, compress: compress };
})(typeof window !== 'undefined' ? window : this);
