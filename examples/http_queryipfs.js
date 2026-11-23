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

const JWT_ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzZXJfMTIzNDUiLCJlbWFpbCI6ImFsZXhAZXhhbXBsZS5jb20iLCJwdWJsaWNLZXkiOiJldGNldGMiLCJyb2xlcyI6WyJ1c2VyIl0sImlhdCI6MTc4NTcxMzY3OSwiZXhwIjoxNzg4MzA1Njc5fQ.KW0hN8XpaoeKB7q9-DYPEhhkHMPyzHUIBrUZIWjAf1w"
const HOST = "api.dev.microfrmr.com";
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
        this.isReady = false;
        console.log('QueryIpfs (http) constructor inst=', this);
    }

    // Unlike the WS version, connect() doesn't open anything - HTTP is
    // request/response, there's no handshake to wait on. It just records the
    // proxy's base URL (e.g. 'http://localhost:7071', no /retrieve or
    // /persist suffix - query()/upload() pick the route) and fires the same
    // "isReady" event the WS observers already key off of, so html callers
    // don't need to branch on transport.
    connect = (baseUrl) => {
        console.log('connect baseUrl', baseUrl);
        //this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.baseUrl = baseUrl;
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
        "Authorization": "Bearer " + JWT_ACCESS_TOKEN,
        "X-Forwarded-Host": HOST,
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

    // TODO move to util file (see getAsByteArray note above)
    // TODO cleanup video signature to detect 66747970 for mp4
    // TODO detect mp3 and others
    // reference : https://en.wikipedia.org/wiki/List_of_file_signatures
    getMimeType = async(arrayBuffer) => {
        const uint8arr = new Uint8Array(arrayBuffer).slice(0, 4); // Check only the first few bytes
        let signature = '';
        for (const byte of uint8arr) {
            signature += byte.toString(16).padStart(2, '0'); // Convert to hex and pad
        }
        signature = signature.toUpperCase();
        console.log(signature);
        switch (signature) {
            // Image types
            case '89504E47': return 'image/png';
            case '47494638': return 'image/gif';
            case 'FFD8FFDB': case 'FFD8FFE0': case 'FFD8FFFE': case 'FFD8FFe1':
            return 'image/jpeg';
            // RIFF is a generic container (WebP, WAV, AVI, ...) - the form
            // type at byte offset 8 is what actually says "WEBP". This is
            // the format ipfsseed's bulk image compressor
            // (lib/imageCompressor.js) prefers whenever the ffmpeg build it
            // runs on has libwebp, which is the common case in Docker/apt-
            // based deployments.
            case '52494646': {
                const formBytes = new Uint8Array(arrayBuffer).slice(8, 12);
                let form = '';
                for (const byte of formBytes) form += byte.toString(16).padStart(2, '0');
                return form.toUpperCase() === '57454250' ? 'image/webp' : null;
            }
            // Video types (MP4 typically starts with '000000' followed by 'ftyp')
            case '00000014': case '00000018':
            if (signature.slice(6, 10) === '66747970') { // ftyp in hex
               return 'video/mp4';
            }
            default:
            let vidMime = () => {
               let uint8arr2 = new Uint8Array(arrayBuffer).slice(4, 12);
               signature = '';
               for (const byte of uint8arr2) {
                   signature += byte.toString(16).padStart(2, '0');
               }
               signature = signature.toUpperCase();
               console.log('vidsignature',signature);
               switch (signature) {
                   case '6674797069736F6D':
                   case '667479704D534E56':
                   case '6674797071742020':
                       return 'video/mp4';
                   default: return null
               };
            };

            return await vidMime();

        }

    }

}
