'use strict';
//const WebSocket = require('ws');

// import {fileTypeFromBuffer} from 'file-type';
const JWT_ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzZXJfMTIzNDUiLCJlbWFpbCI6ImFsZXhAZXhhbXBsZS5jb20iLCJwdWJsaWNLZXkiOiJldGNldGMiLCJyb2xlcyI6WyJ1c2VyIl0sImlhdCI6MTc4NTcxMzY3OSwiZXhwIjoxNzg4MzA1Njc5fQ.KW0hN8XpaoeKB7q9-DYPEhhkHMPyzHUIBrUZIWjAf1w"
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
        this.isReady = false;
        console.log('QueryIpfs constructor inst=', this);
    }

    connect = (ipfproxyws) => {

        console.log('connect ipfproxyws', ipfproxyws);
        this.isReady = false;
        this.ws = new  WebSocket(ipfproxyws,["Bearer",JWT_ACCESS_TOKEN]);
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

    // TODO move to util file
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
            // todo move lower
            case '00000014': case '00000018':
            if (signature.slice(6, 10) === '66747970') { // ftyp in hex
               return 'video/mp4';
            }
            // More signatures need to be added for full coverage (WebM, Ogg, etc.)
            default:
            let vidMime = () => {
               let uint8arr2 = new Uint8Array(arrayBuffer).slice(4, 12); // Check only the 8 bytes starting at index 4
               signature = '';
               for (const byte of uint8arr2) {
                   signature += byte.toString(16).padStart(2, '0'); // Convert to hex and pad
               }
               signature = signature.toUpperCase();
               console.log('vidsignature',signature);
               switch (signature) {
                   case '6674797069736F6D':
                   case '667479704D534E56':
                   case '6674797071742020':
                       return 'video/mp4';
                   //case signature.substring(2) == 'FFFB' | 'FFF3' | 'FFF2':
                   //    return 'video/mp3';
                   default: return null
               };
            };

            return await vidMime();

        }

    }

}


