# ImageViewer — a React component example

Example code showing one way to build a React component on top of `media-compressor`'s browser module — **not** something the package ships or exports. It's a direct port of a Next.js app's `web/components/ImageViewer.js`, generalized so it has no dependency on that app's config or module layout.

For verified, runnable proof this actually works, see **`usage.js`** — run it with:

```
npm run react:demo
```

(from `js/examples/`). Every example below is exercised there with `react-test-renderer`; nothing here is an untested snippet.

## Files

- **`ImageViewer.js`** — the component. Resolves either a directly-supplied `url`, or an `imageCid` via a `fetchMedia` function, sniffs the result's magic bytes (via `media-compressor`'s `browser/mediaDetect`) to tell image from video, and renders it as a Blob object URL.
- **`fetchers.js`** — `createWsFetcher`/`createHttpFetcher`, the two built-in `fetchMedia` implementations (mirroring `../lib/connectors`'s `IpfsConnector` ws/http protocols).
- **`index.js`** — re-exports both of the above.
- **`usage.js`** — the runnable demo.

## Why `fetchMedia` instead of a `transport` prop

`ImageViewer` has no built-in knowledge of ws, http, or IPFS. It only knows this contract:

```js
fetchMedia(id, { onBytes, onError }) => cancelFn
```

`onBytes(Uint8Array)` is called once the bytes arrive; `onError(err)` on failure; the returned `cancelFn` is called on unmount or when `id`/`fetchMedia` changes. `createWsFetcher`/`createHttpFetcher` build one of these from `{ wsUrl | httpUrl, jwtToken, hostname }`, but any function with that shape works — a REST API, a different protocol, a test mock, or a small adapter around an existing `IpfsConnector` instance (see `../lib/connectors`; not used directly here since its `query()` has no per-call cancellation that `ImageViewer`'s cleanup needs).

**Important:** pass a stable `fetchMedia` reference (hold the factory's result in a `useMemo`, or module-level if its config never changes) — it's an effect dependency, so a new function identity every render re-fetches every render.

## Usage

```js
const React = require('react');
const { ImageViewer, createHttpFetcher } = require('./index'); // this is example code, not an installable package — copy the files you need

// Build once, outside render.
const fetchMedia = createHttpFetcher({
  httpUrl: 'http://localhost:9090/fs/retrieve',
  jwtToken: process.env.JWT_ACCESS_TOKEN,
  hostname: 'api.dev.microfrmr.com',
});

function Gallery({ cid }) {
  return React.createElement(ImageViewer, { imageCid: cid, fetchMedia, alt: 'media' });
}
```

Or skip fetching entirely when you already have a URL:

```js
React.createElement(ImageViewer, { url: uploadResult.url, alt: 'media' });
```

### Props

| Prop | Type | Notes |
|---|---|---|
| `imageCid` | `string` | Ignored if `url` is set. |
| `url` | `string` | Renders immediately, no fetch. |
| `fetchMedia` | `(id, { onBytes, onError }) => cancelFn` | Required whenever `imageCid` is used without `url`. |
| `className` | `string` | Applied to the rendered `img`/`video`/placeholder `div`. |
| `alt` | `string` | Passed through to `img`. |

### No JSX

Everything here is plain `React.createElement` calls, not JSX — matching the rest of this package (no build step anywhere). A consumer's own bundler is free to write the equivalent as JSX; this just doesn't require one to run `node --check`/`node usage.js` directly.
