'use strict';

// rn/src/imageCompressor.js — React Native image compression via
// react-native-compressor's `Image.compress`, mirroring
// js/src/imageCompressor.js's shape (probe / compress / extractThumbnail)
// so callers can treat the Node, browser, and RN compressors the same way.
//
// NOT verified against a running RN app or a real device/simulator — this
// environment has no RN runtime to execute it in (unlike js/src and
// js/src/browser, which were run and checked directly). Confirm
// react-native-compressor's actual exported API against whatever version
// you install before relying on this.
//
// Interface deviation from js/src/imageCompressor.js: ffmpeg writes to an
// exact path you give it; react-native-compressor's Image.compress picks
// its own temp location and hands back that URI instead. So compress()/
// extractThumbnail() here return { outputUri } rather than writing to a
// caller-chosen path — move/copy the result yourself (e.g. via
// react-native-fs or expo-file-system) if you need it at a specific
// location.

const { Image } = require('react-native-compressor');
const { Image: RNImage } = require('react-native');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

/**
 * Probes an image for dimensions via React Native's built-in
 * Image.getSize — the one piece of this that needs no extra native
 * module beyond react-native itself. codec/isAnimated/formatBytes aren't
 * available without a file-stat/metadata library (react-native-fs,
 * expo-file-system) and are left null rather than guessed.
 */
function probe(uri) {
  return new Promise((resolve, reject) => {
    RNImage.getSize(
      uri,
      (width, height) => resolve({ width, height, codec: null, isAnimated: null, formatBytes: null }),
      (err) => reject(err instanceof Error ? err : new Error(String(err)))
    );
  });
}

/**
 * Compresses inputUri via react-native-compressor. probeInfo is accepted
 * for interface parity with js/src/imageCompressor.js but unused here —
 * this backend picks its own encode strategy internally, unlike the
 * ffmpeg-CLI path, which branches on probeInfo.isAnimated/alpha itself.
 * opts: { maxDim (or maxWidth/maxHeight), quality (0-100), output
 *         ('jpg'|'png'|'webp') }
 * Returns { outputUri }.
 */
async function compress(inputUri, probeInfo, opts = {}) {
  const outputUri = await Image.compress(inputUri, {
    compressionMethod: 'manual',
    maxWidth: opts.maxDim || opts.maxWidth || 1920,
    maxHeight: opts.maxDim || opts.maxHeight || 1920,
    // quality here is assumed 0-1 to match react-native-compressor's docs
    // at the time of writing — double check against your installed
    // version; some releases of similar libs use a 0-100 scale instead.
    quality: (opts.quality != null ? opts.quality : 80) / 100,
    output: opts.output || 'jpg',
  });
  return { outputUri };
}

/**
 * Same encode path as compress(), defaulting to a thumbnail-sized max
 * dimension and lower quality — a feed-thumbnail-sized variant rather
 * than a distinct code path, matching js/src/imageCompressor.js.
 */
async function extractThumbnail(inputUri, probeInfo, opts = {}) {
  return compress(inputUri, probeInfo, {
    maxDim: opts.maxDim || 320,
    quality: opts.quality != null ? opts.quality : 60,
    output: opts.output,
  });
}

module.exports = {
  IMAGE_EXTENSIONS,
  probe,
  compress,
  extractThumbnail,
};
