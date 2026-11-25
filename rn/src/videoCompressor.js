'use strict';

// rn/src/videoCompressor.js — React Native video compression via
// react-native-compressor's `Video` module, mirroring
// js/src/videoCompressor.js's shape (probe / compress / extractThumbnail).
//
// NOT verified against a running RN app or device/simulator — see
// imageCompressor.js's header for the same caveat. Confirm against the
// actual installed react-native-compressor version before relying on
// this.
//
// Fields js/src/videoCompressor.js gets from ffprobe that this backend
// can't provide without ffmpeg itself (videoCodec, hasAudio) are left
// null rather than guessed.
//
// Same interface deviation as imageCompressor.js: Video.compress() picks
// its own temp output location instead of accepting a destination path,
// so compress() returns { outputUri } rather than writing to a
// caller-chosen path.

const { Video } = require('react-native-compressor');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.wmv', '.mpg', '.mpeg',
]);

/**
 * Probes a video via react-native-compressor's getVideoMetaData.
 * Returns { durationSec, width, height, videoCodec: null, hasAudio: null,
 * formatBytes }.
 */
async function probe(uri) {
  const meta = await Video.getVideoMetaData(uri);
  return {
    durationSec: meta.duration,
    width: meta.width,
    height: meta.height,
    videoCodec: null,
    hasAudio: null,
    formatBytes: meta.size != null ? meta.size : null,
  };
}

/**
 * Compresses inputUri. probeInfo is accepted for interface parity with
 * js/src/videoCompressor.js but unused here — react-native-compressor's
 * 'auto' compressionMethod picks its own bitrate/resolution strategy;
 * pass opts.manual: true to control bitrate/maxSize directly instead.
 * opts: { maxSize (longest-edge px), bitrate (bps), manual (bool),
 *         onProgress (fn) }
 * Returns { outputUri }.
 */
async function compress(inputUri, probeInfo, opts = {}) {
  const outputUri = await Video.compress(
    inputUri,
    {
      compressionMethod: opts.manual ? 'manual' : 'auto',
      maxSize: opts.maxSize || opts.maxHeight || 1080,
      bitrate: opts.bitrate,
    },
    opts.onProgress
  );
  return { outputUri };
}

/**
 * react-native-compressor has no built-in poster-frame extractor.
 * Deliberately left unimplemented rather than faked: a real
 * implementation needs a separate library (e.g.
 * react-native-create-thumbnail, expo-video-thumbnails) that hasn't been
 * chosen yet. Throws until one is picked and wired in here.
 */
async function extractThumbnail() {
  throw new Error(
    'extractThumbnail is not implemented for React Native yet — react-native-compressor has no poster-frame extractor; pick a library ' +
    '(e.g. react-native-create-thumbnail, expo-video-thumbnails) and wire it in here.'
  );
}

module.exports = {
  VIDEO_EXTENSIONS,
  probe,
  compress,
  extractThumbnail,
};
