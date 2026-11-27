# Node CLI examples

Four command-line scripts demonstrating bulk compression and/or upload of media to an IPFS proxy, from simplest to most complete. All four assume a local dev proxy (the hardcoded JWTs and `api.dev.microfrmr.com` host default are dev-only — see `--jwt`/`--host` on the two bulk-compress scripts).

## `examplecompressbulk.js` / `importcompressedbulk.js` — the real demonstrations

These two actually use `media-compressor` (`require('media-compressor')`) — they're what this `examples/` directory is for. Run from `js/examples/` (not from inside `node/`):

```
npm run compress:bulk          # or: node node/examplecompressbulk.js
npm run compress:bulk:dry      # --dry-run: probe + plan only, no encode/upload/writes
```

- **`examplecompressbulk.js`** — video only. Walks `--in` (default `../samples`, i.e. `examples/samples/`), compresses each video via `media-compressor`'s Node `videoCompressor` (`--crf`, `--preset`, `--max-height`, `--deterministic`), rejects anything over `--max-duration` seconds (default 30) *before* touching ffmpeg, and optionally uploads (`--upload`) the result + a poster thumbnail (`--thumbnails`) to `--ipfsproxy` over ws or http.
- **`importcompressedbulk.js`** — the mixed-media counterpart: same video pipeline, plus images (`imageCompressor`, with its own `--image-quality`/`--image-max-dim`/`--thumb-max-dim`). Dispatches by file extension; anything unrecognized is recorded as `skipped_unsupported`, not an error.

Both are resumable: `--manifest` (default `../manifest.json` / `../import-manifest.json`) tracks what's already been processed so a re-run skips completed files unless `--force`. Run with no flags to see the full option list printed at startup, or read each file's own header comment for the complete `--option` reference.

**Default paths are anchored to `examples/`, not to this directory.** `--in`/`--out`/`--manifest` all default to `path.join(__dirname, '..', ...)` specifically so the real sample files in `../samples/` are found regardless of which directory you invoke `node` from — overriding any of them with a relative path (`--in ./foo`) is resolved against your current working directory as usual.

## `importbulk.js` / `importsemibulk.js` — raw upload, no compression

Older, simpler scripts: read every file in a directory and push the raw bytes over a websocket to `${ipfsproxy}/persist`, with no `media-compressor` dependency at all. The difference between them is socket lifecycle:

- **`importbulk.js`** — one websocket for the entire run, all files sent down it in sequence.
- **`importsemibulk.js`** — a brand new websocket per file.

Both read `dirPath = './samples'` relative to the **current working directory**, not to the script's own location (unlike the two scripts above) — run them from `js/examples/` (`node node/importbulk.js`) so that resolves to the real `samples/` directory; running from inside `node/` itself would look for a `node/samples` that doesn't exist.

```
node node/importbulk.js --ipfsproxy ws://localhost:7071
node node/importsemibulk.js --ipfsproxy ws://localhost:7071
```
