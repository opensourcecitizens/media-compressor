'use strict';

// transport.js — ws/http fetch AND upload, for RN. createWsFetcher/
// createHttpFetcher are ported byte-for-byte from js/examples/react/
// fetchers.js: fetch/WebSocket/AbortController are the same Living
// Standard APIs in RN as in a browser (RN's WebSocket supports the same
// `protocols` subprotocol argument and `binaryType = 'arraybuffer'`), so
// zero platform-specific changes were needed for the fetch half. The
// upload half is new — mirrors js/examples/lib/connectors'
// IpfsConnector.upload() (ws: send raw bytes, single text reply = CID;
// http: POST octet-stream, text() reply = CID).
//
// Same gap as the web fetchers: no per-call cancellation on IpfsConnector
// itself is why this exists as a standalone function set rather than a
// thin wrapper around that class.

export function createWsFetcher({ wsUrl, jwtToken, hostname }) {
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

export function createHttpFetcher({ httpUrl, jwtToken, hostname }) {
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

/** Builds an `upload(bytes) => Promise<cid>` function over the IPFS proxy's websocket. */
export function createWsUploader({ wsUrl, jwtToken, hostname }) {
  return function upload(bytes) {
    return new Promise((resolve, reject) => {
      const url = hostname ? `${wsUrl}?append_header_host=${encodeURIComponent(hostname)}` : wsUrl;
      const socket = new WebSocket(url, ['Bearer', jwtToken]);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(bytes.buffer);
      socket.onmessage = (event) => {
        resolve(typeof event.data === 'string' ? event.data : String(event.data));
        socket.close();
      };
      socket.onerror = reject;
    });
  };
}

/** Builds an `upload(bytes) => Promise<cid>` function over a plain authed POST. */
export function createHttpUploader({ httpUrl, jwtToken, hostname }) {
  return async function upload(bytes) {
    const response = await fetch(httpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'X-Forwarded-Host': hostname,
        'Content-Type': 'application/octet-stream',
      },
      body: bytes.buffer,
    });
    if (!response.ok) throw new Error(`persist failed: HTTP ${response.status}`);
    return response.text();
  };
}
