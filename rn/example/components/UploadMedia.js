'use strict';

// components/UploadMedia.js — RN counterpart to
// js/examples/html/uploadipfs_compression.html. Same pipeline: pick a
// file, probe it, reject video over MAX_UPLOAD_VIDEO_DURATION_SEC before compressing,
// compress, upload, show the resulting CID.
//
// This is the first place in this whole rn/ package where
// media-compressor-rn's imageCompressor/videoCompressor actually get
// called, rather than just read as source for API verification (see
// rn/README.md). Still unverified end-to-end the same way as the rest of
// rn/: syntax-checked, never run on a device/simulator.
//
// Differs from the web version in the two places RN forces a difference:
//   - File selection is expo-image-picker (there's no <input type=file>).
//   - media-compressor-rn's compress() doesn't write to a path you
//     choose — it returns { outputUri } to its own temp location (see
//     rn/src/imageCompressor.js's header for why). That output file's
//     bytes are read back via expo-file-system before being handed to
//     the uploader, since the upload functions here take raw bytes, not
//     a file path.

import { useState, useCallback } from 'react';
import { View, Button, Text, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { imageCompressor, videoCompressor } from 'media-compressor-rn';
import * as base64 from '../base64';
import { createHttpUploader, createWsUploader } from '../transport';
import { HTTP_PERSIST_URL, WS_PERSIST_URL, JWT_ACCESS_TOKEN, HOST, MAX_UPLOAD_VIDEO_DURATION_SEC } from '../config';

const httpUpload = createHttpUploader({ httpUrl: HTTP_PERSIST_URL, jwtToken: JWT_ACCESS_TOKEN, hostname: HOST });
const wsUpload = createWsUploader({ wsUrl: WS_PERSIST_URL, jwtToken: JWT_ACCESS_TOKEN, hostname: HOST });

async function readFileBytes(uri) {
  const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  return base64.decode(b64);
}

export default function UploadMedia() {
  const [status, setStatus] = useState('');
  const [cid, setCid] = useState(null);
  const [transport, setTransport] = useState('http');

  const pickAndUpload = useCallback(async () => {
    setCid(null);
    setStatus('');

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setStatus('Media library permission denied.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 1,
    });
    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    const kind = asset.type === 'video' ? 'video' : 'image';

    try {
      let outputUri;

      if (kind === 'video') {
        setStatus('probing video…');
        const probeInfo = await videoCompressor.probe(asset.uri);
        if (probeInfo.durationSec > MAX_UPLOAD_VIDEO_DURATION_SEC) {
          setStatus(`Rejected: video is ${probeInfo.durationSec.toFixed(1)}s, over the ${MAX_UPLOAD_VIDEO_DURATION_SEC}s limit — not compressed, not uploaded.`);
          return;
        }

        setStatus('compressing video…');
        ({ outputUri } = await videoCompressor.compress(asset.uri, probeInfo, { maxSize: 1080 }));
      } else {
        setStatus('probing image…');
        const probeInfo = await imageCompressor.probe(asset.uri);

        setStatus('compressing image…');
        ({ outputUri } = await imageCompressor.compress(asset.uri, probeInfo, { quality: 80, maxDim: 1920 }));
      }

      setStatus('reading compressed output…');
      const bytes = await readFileBytes(outputUri);

      setStatus('uploading…');
      const upload = transport === 'ws' ? wsUpload : httpUpload;
      const resultCid = await upload(bytes);

      setCid(resultCid);
      setStatus('done.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }, [transport]);

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Compress &amp; upload media</Text>
      <View style={styles.row}>
        <Button title="http" onPress={() => setTransport('http')} color={transport === 'http' ? undefined : '#888'} />
        <Button title="ws" onPress={() => setTransport('ws')} color={transport === 'ws' ? undefined : '#888'} />
      </View>
      <Button title="Pick & Upload" onPress={pickAndUpload} />
      {status && <Text>{status}</Text>}
      {cid && <Text selectable>CID: {cid}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8 },
  heading: { fontSize: 16, fontWeight: 'bold' },
  row: { flexDirection: 'row', gap: 8 },
});
