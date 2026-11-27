'use strict';

// examples/react/usage.js — runnable demonstration of ImageViewer.js's
// three usage patterns. `node usage.js` (or `npm run react:demo` from
// examples/) renders each with react-test-renderer and prints what came
// out — this is checked, not just described: a README's code snippets
// would never actually execute, this does.
//
// react-test-renderer stands in for a browser here on purpose: ImageViewer
// is meant for a real app's bundler/DOM, and this package has no build
// step or DOM of its own to render into. It's the same tool used to
// verify ImageViewer/fetchers.js while building them (see git history) —
// using it here as the usage example keeps "how it's shown to work" and
// "how it's proven to work" the same code path, rather than a second,
// unverified description of the first.

const React = require('react');
const { act } = require('react-test-renderer');
const TestRenderer = require('react-test-renderer');
const ImageViewer = require('./ImageViewer');
const { createHttpFetcher, createWsFetcher } = require('./fetchers');

function printRendered(label, renderer) {
  const tree = renderer.toJSON();
  console.log(`${label}: <${tree.type}${tree.props.src ? ` src="${tree.props.src}"` : ''}>`);
}

// 1. Directly-supplied `url` — the simplest case. No `fetchMedia` needed
//    at all; ImageViewer renders it immediately, skipping the fetch path
//    entirely. Use this when you already have a URL (e.g. the result of
//    your own upload call) and don't need to resolve a CID.
async function demoDirectUrl() {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(ImageViewer, { url: 'https://example.com/already-have-this.jpg', alt: 'example' }));
  });
  printRendered('[1. direct url]', renderer);
}

// 2. A from-scratch `fetchMedia` — the extension point. ImageViewer knows
//    nothing about ws/http/IPFS; `fetchMedia` is the entire contract:
//    (id, { onBytes, onError }) => cancelFn. Here it's a fake in-memory
//    source, to show that any byte source works, not just the two
//    built-ins — e.g. this is the shape you'd use to adapt an existing
//    IpfsConnector instance (see ../lib/connectors) instead of using
//    createWsFetcher/createHttpFetcher below.
async function demoCustomFetchMedia() {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  const fetchMedia = (id, { onBytes }) => {
    const timer = setTimeout(() => onBytes(PNG_BYTES), 0);
    return () => clearTimeout(timer); // cancelFn: called on unmount/id change
  };

  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(ImageViewer, { imageCid: 'my-custom-id', fetchMedia }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the effect's onBytes land
  });
  printRendered('[2. custom fetchMedia]', renderer);
}

// 3. createHttpFetcher — the realistic IPFS-backed case, matching
//    IpfsConnector's http contract (Authorization: Bearer + X-Forwarded-
//    Host). Build the fetcher ONCE outside render (useMemo in a real app,
//    module-level here) — fetchMedia is an effect dependency, so a new
//    function identity every render would re-fetch every render.
async function demoHttpFetcher() {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  global.fetch = async (url, opts) => {
    console.log('  (fetch called with url:', url, 'headers:', opts.headers, ')');
    return { ok: true, arrayBuffer: async () => PNG_BYTES.buffer };
  };

  const fetchMedia = createHttpFetcher({
    httpUrl: 'http://localhost:9090/fs/retrieve',
    jwtToken: 'your-jwt-token',
    hostname: 'api.dev.microfrmr.com',
  });

  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(ImageViewer, { imageCid: 'QmExampleCid', fetchMedia }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  printRendered('[3. createHttpFetcher]', renderer);
}

// createWsFetcher follows the same pattern as createHttpFetcher above,
// just with { wsUrl, jwtToken, hostname } instead of { httpUrl, jwtToken,
// hostname } — omitted here since it needs a WebSocket, not fetch, to
// fake convincingly; see ImageViewer's own test history for that version.
void createWsFetcher;

(async () => {
  await demoDirectUrl();
  await demoCustomFetchMedia();
  await demoHttpFetcher();
})().catch((err) => {
  console.error('usage demo failed:', err);
  process.exitCode = 1;
});
