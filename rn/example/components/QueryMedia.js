'use strict';

// components/QueryMedia.js — RN counterpart to js/examples/html/queryipfs.html.
// Same idea: type a CID, fetch its bytes from the proxy, sniff the magic
// bytes to tell image from video, render it.
//
// Differs from the web version in exactly the two places RN forces a
// difference:
//   - No Blob + URL.createObjectURL (doesn't exist in RN). Images render
//     directly from a `data:<mime>;base64,...` URI instead — RN's <Image>
//     supports that natively, no extra dependency.
//   - No built-in <video> element either. Native video players need a
//     real file, not a data URI reliably, so video bytes are written to
//     a temp file via expo-file-system first, then played from that
//     file:// URI with expo-video's <VideoView>.
//
// Unverified like the rest of rn/: syntax-checked, never rendered on a
// device/simulator — no RN runtime exists in this environment.

import { useState, useCallback } from 'react';
import { View, TextInput, Button, Text, Image, StyleSheet } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { useVideoPlayer, VideoView } from 'expo-video';
import { detectMime } from 'media-compressor/browser/mediaDetect';
import * as base64 from '../base64';
import { createHttpFetcher, createWsFetcher } from '../transport';
import { HTTP_RETRIEVE_URL, WS_RETRIEVE_URL, JWT_ACCESS_TOKEN, HOST } from '../config';

const httpFetch = createHttpFetcher({ httpUrl: HTTP_RETRIEVE_URL, jwtToken: JWT_ACCESS_TOKEN, hostname: HOST });
const wsFetch = createWsFetcher({ wsUrl: WS_RETRIEVE_URL, jwtToken: JWT_ACCESS_TOKEN, hostname: HOST });

const VIDEO_TMP_PATH = FileSystem.cacheDirectory + 'query-media-tmp.mp4';

export default function QueryMedia() {
  const [cid, setCid] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const [imageUri, setImageUri] = useState(null);
  const [videoUri, setVideoUri] = useState(null);
  const [transport, setTransport] = useState('http'); // 'http' | 'ws'

  const player = useVideoPlayer(videoUri, (p) => {
    p.loop = false;
  });

  const runQuery = useCallback(async () => {
    if (!cid) return;
    setStatus('loading');
    setImageUri(null);
    setVideoUri(null);

    const onBytes = async (bytes) => {
      const mime = detectMime(bytes);
      if (!mime) {
        setStatus('error');
        return;
      }

      if (mime.startsWith('image')) {
        setImageUri(`data:${mime};base64,${base64.encode(bytes)}`);
        setStatus('ready');
        return;
      }

      // video: write to a real file - see header comment for why.
      await FileSystem.writeAsStringAsync(VIDEO_TMP_PATH, base64.encode(bytes), {
        encoding: FileSystem.EncodingType.Base64,
      });
      setVideoUri(VIDEO_TMP_PATH);
      setStatus('ready');
    };

    const onError = () => setStatus('error');

    const fetchMedia = transport === 'ws' ? wsFetch : httpFetch;
    fetchMedia(cid, { onBytes, onError });
  }, [cid, transport]);

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Query media by CID</Text>
      <View style={styles.row}>
        <Button title="http" onPress={() => setTransport('http')} color={transport === 'http' ? undefined : '#888'} />
        <Button title="ws" onPress={() => setTransport('ws')} color={transport === 'ws' ? undefined : '#888'} />
      </View>
      <TextInput style={styles.input} placeholder="Enter CID" value={cid} onChangeText={setCid} onSubmitEditing={runQuery} />
      <Button title="Retrieve" onPress={runQuery} disabled={!cid} />

      {status === 'loading' && <Text>Retrieving media…</Text>}
      {status === 'error' && <Text>Could not retrieve media</Text>}
      {imageUri && <Image source={{ uri: imageUri }} style={styles.media} />}
      {videoUri && <VideoView player={player} style={styles.media} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8 },
  heading: { fontSize: 16, fontWeight: 'bold' },
  row: { flexDirection: 'row', gap: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 8, borderRadius: 4 },
  media: { width: 256, height: 256, backgroundColor: '#000' },
});
