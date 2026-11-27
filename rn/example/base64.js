'use strict';

// base64.js — dependency-free base64 encode/decode for Uint8Array bytes.
// Hand-rolled rather than relying on a global `btoa`/`atob`/`Buffer`:
// none of those are guaranteed present in every RN/Hermes environment
// without an extra polyfill, and this needs to work regardless of which
// one a consuming app does or doesn't have. Used for:
//   - encoding fetched bytes into a `data:<mime>;base64,...` URI (images
//     render directly from one; see components/QueryMedia.js)
//   - decoding a compressed file's base64 contents (read via
//     expo-file-system) back into raw bytes before sending them as an
//     upload body (see components/UploadMedia.js)

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encode(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : null;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : null;

    result += CHARS[b0 >> 2];
    result += CHARS[((b0 & 0x03) << 4) | (b1 !== null ? b1 >> 4 : 0)];
    result += b1 !== null ? CHARS[((b1 & 0x0f) << 2) | (b2 !== null ? b2 >> 6 : 0)] : '=';
    result += b2 !== null ? CHARS[b2 & 0x3f] : '=';
  }
  return result;
}

export function decode(base64) {
  const clean = base64.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let byteIndex = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = CHARS.indexOf(clean[i]);
    const c1 = CHARS.indexOf(clean[i + 1]);
    const c2 = i + 2 < clean.length ? CHARS.indexOf(clean[i + 2]) : -1;
    const c3 = i + 3 < clean.length ? CHARS.indexOf(clean[i + 3]) : -1;

    bytes[byteIndex++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) bytes[byteIndex++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (c3 >= 0) bytes[byteIndex++] = ((c2 & 0x03) << 6) | c3;
  }
  return bytes;
}
