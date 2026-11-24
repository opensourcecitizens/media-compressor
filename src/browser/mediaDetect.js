'use strict';

// lib/browser/mediaDetect.js — byte-signature (magic-number) detection of
// image/video mime type from the first bytes of a File/Blob's actual
// contents, not its extension or browser-reported .type (a renamed or
// mislabeled file would fool either of those; this looks at what the
// bytes actually are).
//
// Same algorithm as web/components/ImageViewer.js's detectMime and the
// getMimeType duplicates elsewhere in this repo — see
// ../../../../shared/mime-sniff/README.md for why there are multiple
// copies instead of one shared module (three incompatible bundlers/
// runtimes, no workspace tooling) and how they're kept honest: this file
// is checked against the same shared/mime-sniff/test-vectors.js spec via
// check-sync.js's TARGETS, so it can't silently drift from the other five.
//
// Plain <script src> global (window.MediaDetect), no module system —
// matches how every other file in this directory (ipfsconnector_http.js,
// ipfsconnector_ws.js) is loaded by the *.html seed tools; there's no bundler
// here to hand an ES module to.

(function (global) {
  function toHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  function detectMime(bytes) {
    const header = toHex(bytes.slice(0, 4));
    switch (header) {
      case '89504E47':
        return 'image/png';
      case '47494638':
        return 'image/gif';
      case 'FFD8FFDB':
      case 'FFD8FFE0':
      case 'FFD8FFFE':
      case 'FFD8FFE1':
        return 'image/jpeg';
      case '52494646': {
        // RIFF is a generic container (WebP, WAV, AVI, ...) - the form
        // type at byte offset 8 is what actually says "WEBP". This is the
        // format lib/imageCompressor.js (the Node bulk-import path)
        // prefers whenever the ffmpeg build it runs on has libwebp.
        const form = toHex(bytes.slice(8, 12));
        return form === '57454250' ? 'image/webp' : null;
      }
      default: {
        // MP4 ftyp box lives at byte offset 4 (e.g. ....ftypisom) -
        // videoCompressor.js always emits mp4 via `-f mp4`, brand
        // confirmed as "isom" against real ffmpeg output.
        const ftyp = toHex(bytes.slice(4, 12));
        switch (ftyp) {
          case '6674797069736F6D': // ftyp isom
          case '667479704D534E56': // ftyp MSNV
          case '6674797071742020': // ftyp qt
            return 'video/mp4';
          default:
            return null;
        }
      }
    }
  }

  // 'image' | 'video' | null, derived from the detected mime.
  function detectMediaKind(mime) {
    if (!mime) return null;
    if (mime.indexOf('image/') === 0) return 'image';
    if (mime.indexOf('video/') === 0) return 'video';
    return null;
  }

  /**
   * Reads `file` (a File/Blob) into a Uint8Array of its full contents.
   * The one shared FileReader-to-bytes implementation — detectFile below
   * uses it (sliced to the first 12 bytes) instead of duplicating the
   * reader setup, and IpfsConnector's getAsByteArray (ipfsconnector_http.js /
   * ipfsconnector_ws.js, used by uploadipfs.html before an upload) delegates
   * here instead of keeping its own copy.
   */
  function getAsByteArray(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('loadend', (e) => resolve(new Uint8Array(e.target.result)));
      reader.addEventListener('error', () => reject(reader.error || new Error('failed to read file')));
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Reads just enough of `file` (a File/Blob) to run byte-signature
   * detection — 12 bytes covers every format in the switch above, so this
   * never reads the whole file just to classify it.
   * Resolves { mime, kind } — both null when the bytes aren't recognized.
   */
  function detectFile(file) {
    return getAsByteArray(file.slice(0, 12)).then((bytes) => {
      const mime = detectMime(bytes);
      return { mime: mime, kind: detectMediaKind(mime) };
    });
  }

  global.MediaDetect = {
    detectMime: detectMime,
    detectMediaKind: detectMediaKind,
    detectFile: detectFile,
    getAsByteArray: getAsByteArray,
  };
})(typeof window !== 'undefined' ? window : this);
