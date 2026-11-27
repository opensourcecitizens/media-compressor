# Browser demo pages

Three zero-build HTML pages — plain `<script src>` tags, no bundler, no module system. Each defines its config (`JWT_ACCESS_TOKEN`, `HOST`, the proxy URL) as inline `<script>` variables rather than importing anything, since there's no module system to import *from*; open any of them directly in a browser (or via a static file server) against a local dev IPFS proxy.

## `queryipfs.html` — retrieve and render by CID

Loads `../lib/connectors/ipfsconnector_http.js` and `../../src/browser/mediaDetect.js`. Type the CID into the input; on change it connects an `IpfsConnector`, queries for the bytes, detects image-vs-video via `MediaDetect.detectMime`, and sets the result as an `<img>`/`<video>` source via a Blob object URL.

## `uploadipfs.html` — upload a file as-is

Same two scripts as above. Selecting a file reads it into bytes via `MediaDetect.getAsByteArray`; clicking Upload connects the same `IpfsConnector` and persists those bytes unmodified, then renders the returned CID.

## `uploadipfs_compression.html` — compress client-side, then upload

The complete pipeline: also loads `../../src/browser/imageCompressor.js` and `../../src/browser/videoCompressor.js`. Selecting a file detects its real type via `MediaDetect.detectFile` (not the browser's reported `.type` or the extension), probes video duration up front via a native `<video>` element and rejects anything over `MAX_DURATION_SEC` (30s, matching `node/`'s `--max-duration` default) *before* ever loading ffmpeg.wasm, then compresses with `BrowserImageCompressor`/`BrowserVideoCompressor` and uploads the result through the same `IpfsConnector` as the other two pages. `BrowserVideoCompressor` itself loads ffmpeg.wasm lazily from a CDN the first time a video is actually selected — there's no separate script tag for it here, it's pulled in on demand from inside `videoCompressor.js`.

## Shared quirks across all three

- **`IpfsConnector.connect(url, jwtToken, hostname)`** — all three call this the same way; see [`../lib/connectors/README.md`](../lib/connectors/README.md) for what each argument actually does and why `ws`/`http` authenticate differently.
- **The RequireJS CDN `<script>`** in `queryipfs.html`/`uploadipfs.html` (absent from `uploadipfs_compression.html`) is dead weight — nothing on either page calls `define()`/AMD `require()`. Harmless, just unused; not removed since it's not actually broken.
- **The hardcoded JWT/host constants are dev-only**, matching the same shared dev token convention as `node/`'s scripts — not meant to work against anything but a local docker-compose proxy.
