# media-compressor-rn

Image and video compression for React Native, matching the interface shape of `../js/src` (`probe`, `compress`, `extractThumbnail`) so callers can treat Node, browser, and RN compressors the same way — with one deliberate difference: there's no destination-path argument. The native library picks its own temp output location and hands back a URI, so `compress()`/`extractThumbnail()` return `{ outputUri, ... }` instead of writing to a path you chose.

## Install

```
npm install react-native-compressor react-native-nitro-modules
```

Both are peer dependencies — `react-native-nitro-modules` is required by `react-native-compressor@2.x`'s native-module architecture (Nitro Modules), not optional.

## Usage

```js
const { imageCompressor, videoCompressor } = require('media-compressor-rn');

const info = await videoCompressor.probe(fileUri);
const { outputUri } = await videoCompressor.compress(fileUri, info, { maxSize: 1080 });
```

`example/` is a scaffolded Expo app with `react-native-compressor` installed, used to verify the wrapper's assumptions against the library's real source — not a finished demo UI.

## Media compression: algorithms and strategies

Node's `js/src` compresses by shelling out to `ffmpeg`/`ffprobe` — real, open encoders with every parameter exposed. That's not available on-device in React Native (no `child_process`, no bundled ffmpeg binary), so this package wraps [`react-native-compressor`](https://github.com/numandev1/react-native-compressor) instead, a native module backed by each platform's own built-in encoders.

### Why not ffmpeg here too

`react-native-compressor`'s own pitch is the relevant tradeoff: it targets the same output quality as WhatsApp's media compression, at roughly **50KB** added to app size — versus **~9MB** for bundling ffmpeg (e.g. via `ffmpeg-kit-react-native`). The cost of that smaller footprint is control: the exact encoding algorithm isn't published or configurable the way `-crf`/`-preset`/`-c:v` are on the Node side — you tune outcomes (target size, max dimensions, bitrate), not codec internals.

### Images (`src/imageCompressor.js`)

Two compression modes:
- **`auto`** — the library picks quality/dimensions itself, aiming for WhatsApp-equivalent output.
- **`manual`** (what this wrapper uses) — explicit `maxWidth`/`maxHeight` (downscale boundaries) and `quality` (0–1 native scale, default 0.8; this wrapper accepts 0–100 like the Node path and converts). Output is JPEG or PNG only — no WebP support here, unlike the Node/browser paths.

Probing uses `getImageMetaData`, which reads real EXIF (dimensions, file size, GPS/orientation) rather than just decoding pixel dimensions — richer than what either the Node or browser path's `probe()` exposes for free, though this wrapper still reports `codec`/`isAnimated` as `null`: the library doesn't expose either.

### Video (`src/videoCompressor.js`)

Same `auto`/`manual` split. `auto` (the library's default) picks bitrate and resolution heuristically; `manual` exposes `maxSize` (longest-edge pixels, library default 640 — notably smaller than the Node path's 1080 default) and `bitrate` directly. Two options with no Node-side equivalent: `stripAudio` (drop the audio track entirely) and `preserveMetadata` (keep or discard the source's GPS/creation-date metadata — the opposite default of the Node path, which always strips it).

Thumbnails use the library's own `createVideoThumbnail` — a native poster-frame extractor, not a seek-and-grab-one-frame ffmpeg call like the Node path. It always picks its own frame; there's no equivalent to the Node version's "~10% into the duration" seek control.

### What's structurally different from `js/src`, and why

- **No ffprobe-derived fields**: `videoCodec`/`hasAudio` (video) and `codec`/`isAnimated` (image) all come from parsing ffprobe's stream metadata on the Node side. There's no ffprobe here, so these are `null` rather than guessed.
- **No chosen output path**: ffmpeg writes to the exact path you give it. The native encoders behind `react-native-compressor` don't take a destination — they write to their own temp location and return that URI, which is why this package's `compress()`/`extractThumbnail()` return `{ outputUri }` instead of writing to a caller-chosen path.
