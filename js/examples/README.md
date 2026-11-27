# media-compressor-js examples

Runnable demonstrations of using `media-compressor` as a real dependency — not a demo *of* the library's internals, but of what consuming it actually looks like. `package.json` depends on it via `"media-compressor": "file:.."`, the same as any published dependency would be referenced, so every script here does `require('media-compressor')` rather than reaching into `../src`.

## Setup

```
npm install
```

(from this directory). That resolves the local `media-compressor` package, plus everything each subdirectory below needs.

## Layout

- **`node/`** — CLI scripts: bulk-compress and/or upload files to an IPFS proxy from the command line. See its own [README](node/README.md).
  - `examplecompressbulk.js` — video-only. Compresses a directory of videos via `media-compressor`'s Node `videoCompressor`, optionally uploads the result (+ thumbnail) over ws or http. `npm run compress:bulk` / `compress:bulk:dry`.
  - `importcompressedbulk.js` — the mixed-media counterpart: compresses both images and videos from one directory, dispatching by extension.
  - `importbulk.js` / `importsemibulk.js` — simpler, uncompressed bulk uploads over a raw websocket (one socket for the whole run vs. one socket per file).
  - Defaults for `--in`/`--out`/`--manifest` resolve relative to this directory's parent (`examples/`, where `samples/` actually lives), not to `node/` itself — see each script's `CONFIG` block if overriding.
- **`html/`** — zero-build browser pages, each loading its dependencies via plain `<script src>` (no bundler, no module system). See its own [README](html/README.md).
  - `queryipfs.html` — retrieve and render media by CID.
  - `uploadipfs.html` — upload a file as-is.
  - `uploadipfs_compression.html` — like the above, but compresses client-side first via `media-compressor`'s browser `imageCompressor`/`videoCompressor` before uploading.
- **`lib/connectors/`** — the `IpfsConnector` classes (`ipfsconnector_ws.js`/`ipfsconnector_http.js`) the `html/` pages load for proxy I/O. See its own [README](lib/connectors/README.md).
- **`react/`** — an example React component (`ImageViewer`) built on `media-compressor`'s browser `mediaDetect` module — example code, not something the package itself ships. See its own [README](react/README.md); run `npm run react:demo` for a verified-working demonstration.
- **`samples/`** — real sample media (`elkmoon.mp4`, `testImage.jpeg`) the `node/` scripts' default `--in` resolves to.

## A note on what's *not* interchangeable

`node/`'s scripts and `react/`'s component solve the same underlying problem (get media in/out of an IPFS proxy) in different runtimes, and deliberately don't share one implementation: `node/` talks to the proxy directly inside each CLI script, `html/` goes through `lib/connectors`, and `react/` goes through its own `fetchMedia` abstraction (see `react/README.md` for why it doesn't just wrap `lib/connectors` directly). If you're adding a fourth consumer, it's worth deciding which of these three patterns actually fits before copying one wholesale.
