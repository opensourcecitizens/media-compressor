# media-compressor
Image and video compression for Node, the browser, and React Native — compress before you store, upload, or render media, not after.

## When you need this

- **Before persisting to content-addressed storage (IPFS)**: every byte costs upload bandwidth, pin storage, and download bandwidth for everyone who later retrieves it. A phone's raw camera output (a 10–20MB photo, or 100MB+ for a few seconds of 4K video) is wildly disproportionate to what a feed actually needs to display.
- **Before rendering in a UI over a constrained connection**: phones routinely capture at resolutions and bitrates far above what a chat bubble, feed thumbnail, or mobile-data connection can load quickly — "what the camera captured" and "what the UI needs" are two different sizes.
- **Before accepting a user-generated upload at all**: enforcing a hard duration or size cap — this repo's example scripts reject video over 30s by default — needs to happen *before* spending encode time or storage on something that's getting rejected anyway.
- **When what's needed is a thumbnail, not the original**: a feed or grid view wants a small poster frame, not the full-resolution asset — generating one deliberately smaller than the compressed original avoids loading the whole file just to show a preview.

## Repo layout

- **[`js/`](js/README.md)** — Node and browser compressors, built on `ffmpeg`/`ffprobe` (Node) and Canvas/ffmpeg.wasm (browser).
- **[`rn/`](rn/README.md)** — React Native compressor, built on the native module `react-native-compressor`.

## Why both `js/` and `rn/`

`js/`'s compressors are built on ffmpeg — either the real `ffmpeg`/`ffprobe` binaries (Node, via `child_process`) or ffmpeg.wasm (browser, via WebAssembly in a Worker). Neither path exists on React Native: there's no `child_process` to spawn a binary from, and RN's JS engine (Hermes/JSC) isn't a browser, so it can't load ffmpeg.wasm either. Canvas — the browser image path's other building block — doesn't exist on RN at all.

So React Native needs a genuinely different implementation, not a ported one: `rn/` wraps [`react-native-compressor`](https://github.com/numandev1/react-native-compressor), a native module that calls each platform's own on-device encoders instead of ffmpeg. That trade lands differently on purpose — react-native-compressor's own pitch is ~50KB added to app size versus ~9MB for bundling ffmpeg on-device — in exchange for less control over encoding internals than ffmpeg's exposed `-crf`/`-preset`/`-c:v` flags give `js/`. See [`rn/README.md`](rn/README.md#why-not-ffmpeg-here-too) for the detail.

Both expose the same `probe`/`compress`/`extractThumbnail` shape so calling code can treat all three runtimes (Node, browser, RN) consistently — see each package's own README for exactly where that shape has to bend to fit the runtime (e.g. `rn/` has no caller-chosen output path).
