'use strict';

// rn/src/imageCompressor.js — React Native image compression via
// react-native-compressor's `Image.compress`, mirroring
// js/src/imageCompressor.js's shape (probe / compress / extractThumbnail)
// so callers can treat the Node, browser, and RN compressors the same way.
//
// Verified against react-native-compressor@2.0.6's actual source
// (node_modules/react-native-compressor/src/{Image,utils}/index.tsx) —
// see rn/example, a scaffolded Expo app with the package installed for
// exactly this. Still never run against a real device/simulator: no RN
// runtime exists in this environment (unlike js/src and js/src/browser,
// which were run and checked directly), so the shape of the API is
// confirmed but its runtime behavior isn't.
//
// v2.x rewrote this package on react-native-nitro-modules (a peer dep —
// see package.json) — older 1.x releases used a different native-module
// architecture entirely. Don't loosen the peer dependency range without
// re-checking this file against whatever API that version actually has.
//
// Interface deviation from js/src/imageCompressor.js: ffmpeg writes to an
// exact path you give it; react-native-compressor's Image.compress picks
// its own temp location and hands back that URI instead. So compress()/
// extractThumbnail() here return { outputUri } rather than writing to a
// caller-chosen path — move/copy the result yourself (e.g. via
// react-native-fs or expo-file-system) if you need it at a specific
// location.

const { Image, getImageMetaData } = require('react-native-compressor');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']);

/**
 * Probes an image via react-native-compressor's getImageMetaData, which
 * reads real EXIF — unlike React Native core's Image.getSize (dimensions
 * only), this also gives file size and raw EXIF, so formatBytes doesn't
 * have to be left null the way js/browser's RN gap analysis first assumed.
 * codec/isAnimated still aren't available without decoding the file, and
 * are left null rather than guessed.
 */
async function probe(uri) {
  const meta = await getImageMetaData(uri);
  return {
    width: meta.ImageWidth,
    height: meta.ImageHeight,
    codec: null,
    isAnimated: null,
    formatBytes: meta.size != null ? meta.size : null,
    orientation: meta.Orientation,
  };
}

/**
 * Compresses inputUri via react-native-compressor. probeInfo is accepted
 * for interface parity with js/src/imageCompressor.js but unused here —
 * this backend picks its own encode strategy internally, unlike the
 * ffmpeg-CLI path, which branches on probeInfo.isAnimated/alpha itself.
 * opts: { maxDim (or maxWidth/maxHeight), quality (0-100, like the Node
 *        path — converted to this library's native 0-1 scale below),
 *        output ('jpg'|'png' — no 'webp' support here, unlike ffmpeg) }
 * Returns { outputUri }.
 */
async function compress(inputUri, probeInfo, opts = {}) {
  const outputUri = await Image.compress(inputUri, {
    compressionMethod: 'manual',
    maxWidth: opts.maxDim || opts.maxWidth || 1920,
    maxHeight: opts.maxDim || opts.maxHeight || 1920,
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
