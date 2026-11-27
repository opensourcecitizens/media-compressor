'use strict';

// rn/src/videoCompressor.js — React Native video compression via
// react-native-compressor's `Video` module, mirroring
// js/src/videoCompressor.js's shape (probe / compress / extractThumbnail).
//
// Verified against react-native-compressor@2.0.6's actual source
// (node_modules/react-native-compressor/src/{Video,utils}/index.tsx) —
// see rn/example, a scaffolded Expo app with the package installed for
// exactly this. getVideoMetaData and createVideoThumbnail are TOP-LEVEL
// exports of the package, not methods on Video — an earlier draft of this
// file called Video.getVideoMetaData(), which doesn't exist and would
// have thrown at runtime. Still never run against a real device/
// simulator: no RN runtime exists in this environment, so the shape of
// the API is confirmed but its runtime behavior isn't.
//
// v2.x rewrote this package on react-native-nitro-modules (a peer dep —
// see package.json) — don't loosen that peer range without re-checking
// this file against whatever API an older/newer version actually has.
//
// Interface deviation from js/src/videoCompressor.js: ffmpeg writes to an
// exact path you give it; Video.compress()/createVideoThumbnail() pick
// their own temp output location and hand back that URI instead, so
// compress()/extractThumbnail() here return { outputUri, ... } rather
// than writing to a caller-chosen path.

const { Video, getVideoMetaData, createVideoThumbnail } = require('react-native-compressor');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.wmv', '.mpg', '.mpeg',
]);

/**
 * Probes a video via react-native-compressor's getVideoMetaData.
 * Returns { durationSec, width, height, videoCodec: null, hasAudio: null,
 * formatBytes }. videoCodec/hasAudio aren't available without ffmpeg
 * itself (which is the whole reason this backend exists instead) and are
 * left null rather than guessed.
 */
async function probe(uri) {
  const meta = await getVideoMetaData(uri);
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
 * 'auto' compressionMethod (the default) picks its own bitrate/resolution
 * strategy; pass opts.manual: true to control bitrate/maxSize directly
 * instead. maxSize/bitrate are passed through only when given, so the
 * library's own defaults (maxSize 640, auto method) apply otherwise,
 * rather than this wrapper silently overriding them with invented values.
 * opts: { maxSize (longest-edge px), bitrate (bps), manual (bool),
 *         stripAudio (bool), preserveMetadata (bool), onProgress (fn) }
 * Returns { outputUri }.
 */
async function compress(inputUri, probeInfo, opts = {}) {
  const nativeOpts = {
    compressionMethod: opts.manual ? 'manual' : 'auto',
  };
  if (opts.maxSize != null) nativeOpts.maxSize = opts.maxSize;
  if (opts.bitrate != null) nativeOpts.bitrate = opts.bitrate;
  if (opts.stripAudio != null) nativeOpts.stripAudio = opts.stripAudio;
  if (opts.preserveMetadata != null) nativeOpts.preserveMetadata = opts.preserveMetadata;

  const outputUri = await Video.compress(inputUri, nativeOpts, opts.onProgress);
  return { outputUri };
}

/**
 * Poster-frame extraction via react-native-compressor's own
 * createVideoThumbnail — no separate thumbnail library needed (an earlier
 * draft of this file assumed one would be, and threw instead of guessing
 * a nonexistent API; createVideoThumbnail turned out to already exist).
 * durationSec/opts is accepted for interface parity with
 * js/src/videoCompressor.js's extractThumbnail(inputPath, thumbPath,
 * durationSec, opts) but there's no seek-position control here —
 * createVideoThumbnail always grabs its own frame, not one at a caller-
 * chosen offset.
 * Returns { outputUri, size, mime, width, height } — size/mime/width/
 * height come straight from createVideoThumbnail's result, which is more
 * than js/src's Node version returns (it returns nothing; the caller
 * already knows the path they requested).
 */
async function extractThumbnail(inputUri, durationSec, opts = {}) {
  const result = await createVideoThumbnail(inputUri, { quality: opts.quality });
  return {
    outputUri: result.path,
    size: result.size,
    mime: result.mime,
    width: result.width,
    height: result.height,
  };
}

module.exports = {
  VIDEO_EXTENSIONS,
  probe,
  compress,
  extractThumbnail,
};
