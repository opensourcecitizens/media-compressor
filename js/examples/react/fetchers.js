'use strict';

// examples/react/fetchers.js — EXAMPLE code, see ImageViewer.js's header.
// The two built-in `fetchMedia` implementations ImageViewer.js's
// `fetchMedia` prop expects: a function shaped (id, { onBytes, onError })
// => cancelFn. Factored out of ImageViewer.js so the component itself
// stays transport-agnostic — it calls whatever `fetchMedia` it's given,
// nothing in it knows ws/http/IPFS exist at all.
//
// These mirror ../lib/connectors' IpfsConnector exactly (JWT as a WS
// subprotocol since the browser WS handshake can't carry an Authorization
// header; a real "Authorization: Bearer" header over http) rather than
// reimplementing a third variant of the same two strategies. They're not
// literally built on IpfsConnector itself, because its query() has no
// per-call cancellation — ImageViewer's cleanup-on-unmount needs one. A
// consumer who already has a connected IpfsConnector instance can still
// use it instead of these, by writing a `fetchMedia`-shaped adapter
// around connector.query() — these two factories are a convenient
// default, not the only option.

/**
 * Builds a `fetchMedia` function that retrieves `id` over the IPFS proxy's
 * websocket endpoint. opts: { wsUrl, jwtToken, hostname }.
 */
function createWsFetcher({ wsUrl, jwtToken, hostname }) {
  return function fetchMedia(id, { onBytes, onError }) {
    let cancelled = false;

    const url = hostname ? `${wsUrl}?append_header_host=${encodeURIComponent(hostname)}` : wsUrl;
    const socket = new WebSocket(url, ['Bearer', jwtToken]);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => socket.send(id);

    socket.onmessage = async (event) => {
      if (cancelled) return;
      const buffer = event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer();
      onBytes(new Uint8Array(buffer));
      socket.close();
    };

    socket.onerror = (error) => {
      if (!cancelled) onError(error);
    };

    return () => {
      cancelled = true;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    };
  };
}

/**
 * Builds a `fetchMedia` function that retrieves `id` over a plain authed
 * GET, same contract as IpfsConnector.query() over http. opts: { httpUrl,
 * jwtToken, hostname }.
 */
function createHttpFetcher({ httpUrl, jwtToken, hostname }) {
  return function fetchMedia(id, { onBytes, onError }) {
    const controller = new AbortController();

    fetch(`${httpUrl}/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'X-Forwarded-Host': hostname,
      },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`retrieve failed: HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        onBytes(new Uint8Array(buffer));
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        onError(error);
      });

    return () => controller.abort();
  };
}

module.exports = {
  createWsFetcher,
  createHttpFetcher,
};
