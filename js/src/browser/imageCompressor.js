'use strict';

// lib/browser/imageCompressor.js — client-side image compression via the
// Canvas API. Deliberately not ffmpeg.wasm: unlike video, a browser has a
// real, zero-dependency way to re-encode a still image (draw it to a
// <canvas>, read it back with toBlob) — no ~30MB WASM download needed just
// for images. This mirrors lib/imageCompressor.js's (the Node bulk-import
// path's) goals — downscale-only, WebP preferred with a safe fallback,
// never ship a file bigger than the source — using browser-native APIs
// instead of shelling out to a native ffmpeg binary, which isn't available
// in a browser at all.
//
// What's NOT attempted here, on purpose:
//   - Animated GIF/WebP: Canvas's drawImage only ever grabs a single
//     frame. Re-encoding an animated source through this path would
//     silently flatten it to a still image — the exact failure mode
//     lib/imageCompressor.js's Node-side codec selection (picking `gif` as
//     a fallback specifically because it preserves animation) was built
//     to avoid. So any GIF or WebP input is skipped untouched here rather
//     than risk destroying an animation this code can't detect frame
//     count for cheaply. compress() reports `skipped: true` with a reason
//     so callers can tell "not compressed" apart from "failed".
//   - EXIF stripping isn't a separate step: Canvas's drawImage/toBlob
//     round-trip drops all metadata (including GPS EXIF tags) by
//     construction — the same privacy outcome lib/imageCompressor.js gets
//     from `-map_metadata -1`, just automatic here rather than a flag.
//
// Plain <script src> global (window.BrowserImageCompressor) — see
// mediaDetect.js's header for why there's no module system in this
// directory.

(function (global) {
  const SKIP_MIME_TYPES = { 'image/gif': true, 'image/webp': true };

  function scaleDimensions(width, height, maxDim) {
    if (!maxDim || (width <= maxDim && height <= maxDim)) return { width, height };
    const scale = maxDim / Math.max(width, height);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  function loadBitmap(file) {
    // createImageBitmap decodes off the main thread and works directly
    // from a Blob in every current browser; fall back to the classic
    // <img> + object URL dance only if it's unavailable.
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file);
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('could not decode image'));
      };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error(`canvas.toBlob produced no data for ${mime}`))),
        mime,
        quality
      );
    });
  }

  /**
   * Encodes `canvas` preferring WebP, falling back to JPEG if the browser
   * doesn't actually support WebP output. Some browsers accept the mime
   * string without complaint but silently hand back a PNG anyway — that's
   * detected by checking the returned blob's real .type, not just trusting
   * the request. Others reject/produce no blob at all for an unsupported
   * type rather than substituting one — canvasToBlob rejects in that case,
   * so the webp attempt is wrapped rather than left to propagate, or an
   * unsupported browser would throw here instead of falling back to jpeg.
   */
  async function encodeCanvas(canvas, quality) {
    try {
      const webp = await canvasToBlob(canvas, 'image/webp', quality);
      if (webp.type === 'image/webp') return { blob: webp, mime: 'image/webp' };
    } catch (err) {
      // fall through to jpeg below
    }
    const jpeg = await canvasToBlob(canvas, 'image/jpeg', quality);
    return { blob: jpeg, mime: 'image/jpeg' };
  }

  /**
   * Compresses an image File/Blob. Returns:
   *   { blob, mime, width, height, skipped, reason }
   * `skipped: true` (blob === the original file, mime === its detected
   * type) means "left untouched" — an animated source, a decode failure,
   * or a case where compression didn't actually save anything — not a
   * thrown error; callers upload `blob` either way.
   *
   * opts: { quality=0.8 (Canvas toBlob's native 0–1 scale, not the Node
   *         lib's 0–100 -q:v scale — deliberately not translated, so this
   *         reads like ordinary Canvas API code), maxDim=1920 }
   */
  async function compress(file, opts) {
    opts = opts || {};
    const quality = opts.quality != null ? opts.quality : 0.8;
    const maxDim = opts.maxDim || 1920;

    const detected = await global.MediaDetect.detectFile(file);
    const mime = detected.mime || file.type || null;

    if (mime && SKIP_MIME_TYPES[mime]) {
      return { blob: file, mime: mime, width: null, height: null, skipped: true, reason: 'animated-source-not-recompressed' };
    }

    let bitmap;
    try {
      bitmap = await loadBitmap(file);
    } catch (err) {
      return { blob: file, mime: mime, width: null, height: null, skipped: true, reason: `decode-failed: ${err.message}` };
    }

    // ImageBitmap only ever has .width/.height; the <img> fallback path's
    // HTMLImageElement has both, but .naturalWidth/.naturalHeight is the
    // platform-correct property for its actual decoded size (.width can
    // reflect CSS/layout, not that this element is ever attached to the
    // DOM here, but naturalWidth is unambiguous regardless).
    const sourceWidth = bitmap.naturalWidth != null ? bitmap.naturalWidth : bitmap.width;
    const sourceHeight = bitmap.naturalHeight != null ? bitmap.naturalHeight : bitmap.height;
    const { width, height } = scaleDimensions(sourceWidth, sourceHeight, maxDim);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (bitmap.close) bitmap.close(); // release ImageBitmap decode memory promptly

    const encoded = await encodeCanvas(canvas, quality);

    if (encoded.blob.size >= file.size) {
      return { blob: file, mime: mime, width: sourceWidth, height: sourceHeight, skipped: true, reason: 'compressed-not-smaller' };
    }

    return { blob: encoded.blob, mime: encoded.mime, width: width, height: height, skipped: false, reason: null };
  }

  global.BrowserImageCompressor = { compress: compress };
})(typeof window !== 'undefined' ? window : this);
