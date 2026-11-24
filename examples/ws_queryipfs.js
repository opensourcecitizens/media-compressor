'use strict';
//const WebSocket = require('ws');

// import {fileTypeFromBuffer} from 'file-type';
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
        this.ws;
        this.jwtToken = null;
        this.hostname = null;
        this.isReady = false;
        console.log('QueryIpfs constructor inst=', this);
    }

    // hostname is accepted for API parity with http_queryipfs.js's
    // connect(url, jwtToken, hostname) — a browser WebSocket handshake
    // can't carry a custom "X-Forwarded-Host" header the way a fetch()
    // request can (see http_queryipfs.js's header comment), so it isn't
    // sent to the server here; it's stored on the instance in case a
    // caller or future transport needs it.
    connect = (ipfproxyws, jwtToken, hostname) => {

        console.log('connect ipfproxyws', ipfproxyws);
        this.isReady = false;
        this.jwtToken = jwtToken;
        this.hostname = hostname;
        this.ws = new  WebSocket(ipfproxyws,["Bearer",jwtToken]);
         console.log('this.ws header=', this.ws);
        var parent = this;
        this.ws.addEventListener('message', function(event) {
           console.info(this.ws?.id + ':',event.data );
        });
        this.ws.addEventListener('open', function open() {
          this.isReady = true;
          console.log('on open ready=', this.isReady);
          console.log('on open parent=', parent);
          parent.notifyObservers(/*event=*/{
                   type: "isReady",
                   value: this.isReady
               });
        });

        this.ws.addEventListener('error', function(error) {
           console.warn(this.ws?.id + ':',error.type, JSON.stringify( error) );
           this.isReady = false;
           throw error;
        });



        /*let trial = 10;
        while(trial>0 && this.isReady==false){
            await setTimeout(()=>{

            },1000);
            console.log('checking ready trial :' + trial)
            trial--;
        }*/

        //await until(_ => this.isReady == true);
        //return Promise.resolve().then(()=> this.isReady);
        return this.isReady;
    }

    close = () => {
        this.ws?.close();
    }

    query = (cID, callBack) => {
        try{
            // console.log('In query with callback ', callBack);
            //this works ok for small data but eventually finally is called
            //this.ws.addEventListener('message', callBack);
            // this is a better implementation to control what to after a callBack is called
            this.ws.addEventListener('message', ()=>{
                eval("callBack(event)");

                setTimeout(()=>{
                    this.ws?.removeEventListener('message', callBack);
                    console.info('removed ws listener');
                }, 1000);

            });
            this.ws.send(cID);
        } catch(error){
            throw error;
        } finally {
            /*setTimeout(()=>{
                this.ws?.removeEventListener('message', callBack);
            }, 4000);
            */
        }
    }

    upload = (data, callBack) => {
      try {
        //read images and send binary
        // console.log('upload callback',callBack);
        this.ws.addEventListener('message', ()=>{
            // synchronous process:
            // executes callback then removes listener
            eval("callBack(event)");

            setTimeout(()=>{
                this.ws?.removeEventListener('message', callBack);
                console.info('removed ws listener');
            }, 5000);

        });
        this.ws.send(data);
      } catch(error) {
        console.error(error);
        throw error;
      } finally{
         // setTimeout(()=>{
              //this.ws?.removeEventListener('message', callBack);
              //console.warn('removing ws listener');
         // }, 10000);
      }
    }

    getIsReady = () => {
        this.isReady;
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

    // TODO move to util file
    getAsByteArray = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            // Register event listeners
            reader.addEventListener("loadend", (e) => {
                // The result is an ArrayBuffer, which we wrap in a Uint8Array
                const arrayBuffer = e.target.result;
                const uint8Array = new Uint8Array(arrayBuffer);
                resolve(uint8Array);
            });

            reader.addEventListener("error", reject);

            // Read the file as an ArrayBuffer
            reader.readAsArrayBuffer(file);
        });
    }

    // Byte-signature mime detection lives in MediaDetect now
    // (src/browser/mediaDetect.js) — delegate instead of keeping a second,
    // drifted copy of the same signature table here (see
    // http_queryipfs.js's getMimeType, which had this exact duplicate too).
    // Callers keep passing an ArrayBuffer, same as before. Requires
    // mediaDetect.js to be loaded (<script src>) before this method is
    // called.
    getMimeType = async (arrayBuffer) => MediaDetect.detectMime(new Uint8Array(arrayBuffer));

}


