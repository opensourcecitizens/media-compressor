# media-compressor-js

Image and video compression for Node and the browser. Two separate runtimes behind one interface:

- **`src/`** — Node. Compresses by spawning the real `ffmpeg`/`ffprobe` binaries as child processes. Used by the bulk-import CLI scripts in `examples/`.
- **`src/browser/`** — Browser. Compresses using Web APIs only (Canvas for images, ffmpeg.wasm for video) — no server round-trip. Used by the HTML demos in `examples/`.

Both expose the same shape: `probe(input, opts)`, `compress(input, output, probeInfo, opts)`, `extractThumbnail(input, output, ..., opts)`.

## Install

```
npm install
```

## Usage

```js
const { imageCompressor, videoCompressor } = require('media-compressor-js');

const info = await videoCompressor.probe('input.mp4');
await videoCompressor.compress('input.mp4', 'output.mp4', info, { crf: 22, preset: 'slow' });
```

Browser entry points are separate subpaths (`media-compressor-js/browser/imageCompressor`, etc.) since they depend on `window`/`Canvas`/ffmpeg.wasm and can't run in Node.

See `examples/` for runnable scripts and HTML demos of both.

## Media compression: algorithms and strategies

### Images — Node (`src/imageCompressor.js`)

Compresses via `ffmpeg`, choosing the output codec at runtime rather than hardcoding one, because `libwebp` is an optional ffmpeg build flag, not a given:

- **libwebp available** → WebP for everything (best compression, supports alpha and animation).
- **not available, no alpha channel** → MJPEG (`-q:v` mapped from a 0–100 quality to ffmpeg's 2–31 qscale, where 2 is best).
- **not available, source may have alpha** (`.png`/`.webp`) → PNG (lossless, keeps transparency rather than silently flattening it).
- **not available, animated** → GIF (ffmpeg's built-in encoder, preserves animation instead of collapsing to one frame).

ffmpeg capability is probed once per binary and cached, not re-probed per file. Downscaling is aspect-ratio-preserving and **never upscales** (`scale='min(iw,maxDim)':'min(ih,maxDim)'`). EXIF (including GPS) is stripped unconditionally via `-map_metadata -1` before any upload — a privacy default, not just a size one. Thumbnails reuse the same encode path with a smaller `maxDim`/`quality`, not a separate code path.

### Video — Node (`src/videoCompressor.js`)

`libx264` at a configurable CRF (default 22 — lower is better quality/bigger file) and preset (default `slow`), profile `high`, level `4.0`, `yuv420p` pixel format for broad compatibility. Audio is re-encoded to AAC 128kbps/48kHz when present, dropped entirely otherwise. Downscaling only triggers if the source is taller than `maxHeight` (`scale=-2:maxHeight`), never upscales.

Two strategies worth calling out specifically:
- **Deterministic re-encoding** (`opts.deterministic`): forces `-threads 1` plus `-fflags +bitexact -flags:v +bitexact`, so re-encoding an unchanged source produces the same bytes on every run — the same content-addressed CID on IPFS, avoiding duplicate pins of identical content. Costs encode speed (single-threaded) for that guarantee.
- **Progressive-start output**: `-movflags +faststart` moves the `moov` atom to the front of the file, so playback from an IPFS gateway can begin before the whole object has downloaded.

Thumbnails are a single JPEG frame grabbed at ~10% into the video's duration (`-ss` seek + `-frames:v 1`), not the first frame (often a black/blank frame).

### Images — Browser (`src/browser/imageCompressor.js`)

Canvas API only (`drawImage` → `toBlob`) — deliberately not ffmpeg.wasm, since a browser already has a native, zero-dependency way to re-encode a still image, unlike video. WebP is attempted first; if the browser's `toBlob` silently substitutes a different format (checked via the *returned* blob's real `.type`, not just trusting the request), it falls back to JPEG. Downscaling is aspect-ratio-preserving and never upscales. Animated GIF/WebP sources are **skipped untouched** rather than compressed — Canvas's `drawImage` only ever grabs a single frame, and silently flattening an animation to a still image is treated as a worse outcome than not compressing at all. EXIF is stripped as a side effect of the Canvas round-trip, not a separate step. If the compressed result isn't actually smaller than the source, the original is kept.

### Video — Browser (`src/browser/videoCompressor.js`)

ffmpeg.wasm (the same encoder as the Node path, compiled to WebAssembly, run in a Worker) — there's no native browser API for video re-encoding the way Canvas covers images. Real cost: ~30MB of WASM downloaded once per page session, and single-threaded, native-slow x264 encoding on the uploader's own device. To avoid paying that cost needlessly, `probe()` deliberately does **not** use ffmpeg.wasm at all — a native `<video>` element already gives duration/dimensions for free, so an over-long upload can be rejected before the WASM is ever loaded.

### Supporting strategy: content-based type detection (`src/browser/mediaDetect.js`)

Not a compression algorithm itself, but the strategy both image and video paths lean on: mime type is detected from the file's actual byte signature (magic numbers — PNG/GIF/JPEG headers, the RIFF/WEBP form type, the MP4 `ftyp` box), never from file extension or the browser-reported `.type`, both of which a renamed or mislabeled file would fool.
