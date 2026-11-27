# IpfsConnector — ws/http proxy clients

Two plain `<script src>` globals, no module system — `ipfsconnector_ws.js` and `ipfsconnector_http.js` each define a global `IpfsConnector` class with the same public surface, loaded one at a time by whichever HTML page needs it (see `../../html/`). They're how `queryipfs.html`/`uploadipfs.html`/`uploadipfs_compression.html` retrieve and persist media by CID against an IPFS proxy, over websocket or plain HTTP respectively.

## Why two files with the same class name

A browser page picks exactly one `<script src>` for its transport and gets one global `IpfsConnector` — the two files are never loaded together, so there's no actual naming collision, just a deliberate "same interface, pick your transport" split. The two differ only in how they authenticate and move bytes:

- **`ipfsconnector_ws.js`**: a browser WebSocket handshake can't carry an `Authorization` header, so the JWT rides in as a subprotocol instead — `new WebSocket(url, ["Bearer", jwtToken])`. `hostname` is accepted by `connect()` for API parity with the http version but isn't actually sent anywhere over ws (there's no header to put it in); it's just stored on the instance.
- **`ipfsconnector_http.js`**: a plain `fetch()` with a real `Authorization: Bearer <token>` header and an `X-Forwarded-Host: <hostname>` header on every request — no handshake workaround needed.

## API

```js
const connector = new IpfsConnector();
connector.addObserver(someObserver); // Observer pattern — see Observable/Observer in either file
connector.connect(url, jwtToken, hostname);
// ws: url is the proxy's ws:// retrieve/persist endpoint
// http: url is the proxy's http(s):// base (query()/upload() append the route)

connector.query(cid, callback);      // callback(event) — event.data is the retrieved bytes
connector.upload(data, callback);    // callback(event) — event.data is the resulting CID (string)
connector.getIsReady();
connector.close();
```

`connect()` fires an `"isReady"` event through the Observer pattern once ready — `ws` after the socket actually opens, `http` immediately (there's no handshake to wait on). Register an observer *before* calling `connect()` if you need to react to that.

### Callback data isn't quite the same shape across transports

- `ws`'s `query()`/`upload()` callbacks receive the raw WebSocket `MessageEvent` — `event.data` is whatever the proxy sent (an `ArrayBuffer`/`Blob` for retrieve, a text CID for persist).
- `http`'s callbacks receive an object shaped *like* a `MessageEvent` (`{ data: blob }` for `query()`, `{ data: cidString }` for `upload()`) so existing `event.data`-reading callers work unchanged — but it's a plain object, not a real `MessageEvent`.

A caller that only reads `event.data` doesn't need to care; one that checks `event instanceof MessageEvent` or similar would.

### What's missing, on purpose

- **No per-call cancellation.** `query()`/`upload()` can't be individually aborted — only `close()` (tears down the whole connection/readiness state) is available. `js/examples/react/fetchers.js` built its own `fetchMedia` implementations rather than wrapping these classes directly specifically because of this gap — see that directory's README for the adapter pattern if you need cancellation on top of this protocol.
- **No `getMimeType`/`getAsByteArray`** — these existed earlier but were removed once the HTML pages switched to calling `media-compressor`'s `browser/mediaDetect` module directly instead of going through the connector. Byte-sniffing media type and reading a `File` into bytes aren't this class's job.

## Where these are loaded

```html
<script src="../lib/connectors/ipfsconnector_ws.js"></script>
<!-- or -->
<script src="../lib/connectors/ipfsconnector_http.js"></script>
```

(paths as seen from `../../html/*.html`). Only `ipfsconnector_http.js` is currently wired into any HTML page — `ipfsconnector_ws.js` is kept at parity but not yet referenced by a script tag.
