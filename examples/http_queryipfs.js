'use strict';

// HTTP counterpart to ws_queryipfs.js — same public surface (connect / close /
// query / upload / getIsReady / getMimeType / getAsByteArray) so queryipfs.html
// and uploadipfs.html can swap script src + endpoint and keep their Observer
// wiring unchanged.
//
// Auth: the WS version has to smuggle the JWT in as a subprotocol
// (new WebSocket(url, ["Bearer", token])) because the WS handshake can't carry
// an Authorization header from a browser. Plain HTTP requests don't have that
// restriction, so this file sends a real "Authorization: Bearer <token>" header
// on every request instead.
//
// HTTP/2 vs authed HTTP/1.1: fetch() doesn't let a caller pick the wire
// protocol — that's negotiated by the browser/server via ALPN, and only
// applies over TLS. Point BASE_URL at an https:// ipfs-proxy origin and the
// browser will use h2 transparently when the server supports it; against a
// plain http:// origin (e.g. localhost dev, per docker-compose.yml's
// ipfs-proxy:7071) it's authed HTTP/1.1. No code path changes either way —
// the bearer token just rides along per request.
//
// NOTE: the proxy image (prelimtek/prelimtek-ipfsproxy) only documents a WS
// contract in this repo (docker-compose.yml exposes 7071 request / 7072
// health). The /retrieve/:cid and /persist REST routes below are this file's
// best-effort mirror of that WS contract, same spirit as the speculative
// commented-out URLs already left in ws_queryipfs.js / *.html — confirm
// against the proxy's actual HTTP routes before relying on this in anything
// but local dev.

// Ref: Observer observable
// https://blog.bitsrc.io/the-observer-pattern-in-javascript-the-key-to-a-reactive-behavior-f28236e50e10
class Observable {
    constructor() {
        this.observers = [];
    }

    addObserver(obs) {
        this.observers.push(obs)
    }

    notifyObservers(event) {
        this.observers.forEach( o => o.update(event))
    }
};

class Observer {
    update(event) {
        if(this.eventIsRelevant(event)) {
            this.reactToEvent(event)
        }
    }

    eventIsRelevant() {
        throw new Error("This needs to be implemented")
    }

    reactToEvent() {
        throw new Error("This needs to be implemented")
    }
};

class QueryIpfs extends Observable {
    constructor(){
        super();
        this.baseUrl = null;
        this.jwtToken = null;
        this.hostname = null;
        this.isReady = false;
        console.log('QueryIpfs (http) constructor inst=', this);
    }

    // Unlike the WS version, connect() doesn't open anything - HTTP is
    // request/response, there's no handshake to wait on. It just records the
    // proxy's base URL (e.g. 'http://localhost:7071', no /retrieve or
    // /persist suffix - query()/upload() pick the route), the auth token and
    // the forwarded hostname (both required by the proxy on every request —
    // see authHeaders()), and fires the same "isReady" event the WS
    // observers already key off of, so html callers don't need to branch on
    // transport.
    connect = (baseUrl, jwtToken, hostname) => {
        console.log('connect baseUrl', baseUrl);
        //this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.baseUrl = baseUrl;
        this.jwtToken = jwtToken;
        this.hostname = hostname;
        this.isReady = true;
        console.log('on connect ready=', this.isReady);
        this.notifyObservers(/*event=*/{
            type: "isReady",
            value: this.isReady
        });
        return this.isReady;
    }

    close = () => {
        // no persistent connection to tear down; kept for API parity with
        // the WS version so callers can call q.close() unconditionally.
        this.isReady = false;
    }

    authHeaders = (extra = {}) => ({
        "Authorization": "Bearer " + this.jwtToken,
        "X-Forwarded-Host": this.hostname,
        ...extra,
    });

    query = async (cID, callBack) => {
        if (!this.baseUrl) throw new Error('call connect(baseUrl) before query()');
        try {
            const response = await fetch(`${this.baseUrl}/${encodeURIComponent(cID)}`, {
                method: 'GET',
                headers: this.authHeaders(),
            });
            if (!response.ok) {
                throw new Error(`retrieve failed: HTTP ${response.status}`);
            }
            const blob = await response.blob();
            // shaped like a WS MessageEvent so existing dataCallback(event)
            // implementations (event.data.arrayBuffer()) work unchanged.
            callBack({ data: blob });
        } catch (error) {
            console.error(error);
            throw error;
        }
    }

    upload = async (data, callBack) => {
        if (!this.baseUrl) throw new Error('call connect(baseUrl) before upload()');
        try {
            const response = await fetch(`${this.baseUrl}`, {
                method: 'POST',
                headers: this.authHeaders({ "Content-Type": "application/octet-stream" }),
                body: data,
            });
            if (!response.ok) {
                throw new Error(`persist failed: HTTP ${response.status}`);
            }
            const cid = await response.text();
            // shaped like a WS MessageEvent (event.data === CID string), to
            // match existing uploadCallback(event) implementations.
            callBack({ data: cid });
        } catch (error) {
            console.error(error);
            throw error;
        }
    }

    getIsReady = () => {
        return this.isReady;
    }

    // unused
    arrayBufferToBase64_large = (buffer) => {
        const bytes = new Uint8Array(buffer);
        const binary = bytes.reduce((data, byte) => data + String.fromCharCode(byte), '');
        return window.btoa(binary);
    }
    // unused
    arrayBufferToBase64Async = (buffer) => {
        return new Promise((resolve, reject) => {
            const blob = new Blob([buffer], { type: 'application/octet-stream' });
            const reader = new FileReader();
            reader.onload = (event) => {
                const dataUrl = event.target.result;
                // Extract the base64 string part from the Data URL
                const base64 = dataUrl.split(',')[1];
                resolve(base64);
            };
            reader.onerror = (error) => reject(error);
            reader.readAsDataURL(blob);
        });
    }

    // TODO move to util file (duplicated from ws_queryipfs.js - both files
    // are loaded standalone via <script src> in the *.html seed tools, no
    // module system in play, so this stays copy/pasted until that changes)
    getAsByteArray = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.addEventListener("loadend", (e) => {
                const arrayBuffer = e.target.result;
                const uint8Array = new Uint8Array(arrayBuffer);
                resolve(uint8Array);
            });

            reader.addEventListener("error", reject);

            reader.readAsArrayBuffer(file);
        });
    }

    // Byte-signature mime detection lives in MediaDetect now
    // (src/browser/mediaDetect.js) — delegate instead of keeping a second,
    // drifted copy of the same signature table here. Callers keep passing
    // an ArrayBuffer, same as before; MediaDetect.detectMime does its own
    // slicing internally. Requires mediaDetect.js to be loaded (<script src>)
    // before this method is called.
    getMimeType = async (arrayBuffer) => MediaDetect.detectMime(new Uint8Array(arrayBuffer));

}
