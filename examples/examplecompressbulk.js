#!/usr/bin/env node
'use strict';

// examplecompressbulk.js — bulk mp4 compression + seed for ipfsseed/samples.
//
// Video-only entry point. For a directory of mixed image + video files, use
// importcompressedbulk.js instead — both files share the same encode logic via
// lib/videoCompressor.js, so behavior here can't drift from there.
//
// Replaces the mp4video_ffmpeg_compression.js sketch (browser @ffmpeg/ffmpeg,
// single file, CRF 0 "lossless" which is actually larger than source and
// often undecodable on iOS/Safari). This runs native ffmpeg/ffprobe as child
// processes — real multithreading, no WASM heap ceiling, streams to disk
// instead of holding 3-4 in-memory copies per file.
//
// Hard requirement: this file explicitly rejects any source video longer
// than --max-duration seconds (default 30s) *before* touching ffmpeg for
// encoding — it is only ever run once per file for ffprobe, then skipped
// with a logged error and recorded in the manifest. See processOne().
//
// Upload contract is copy-pasted intentionally (not imported) to match the
// two existing seed clients rather than invent a third shape:
//   - ws://...   -> ws_queryipfs.js / importbulk.js: `${base}/persist`,
//                   subprotocol ["Bearer", token], raw binary send,
//                   single text message reply = CID.
//   - http(s)://... -> http_queryipfs.js: `${base}/fs/persist`,
//                   POST with Authorization: Bearer + X-Forwarded-Host,
//                   octet-stream body, text() reply = CID.
//
// Usage:
//   node examplecompressbulk.js [options]
//
// Options:
//   --in <dir>            source directory (default: ./samples)
//   --out <dir>            compressed-output directory (default: ./compressed)
//   --manifest <file>      resume/progress manifest (default: ./manifest.json)
//   --recursive            walk --in recursively (default: false)
//   --concurrency <n>      parallel ffmpeg jobs (default: cpus/4, min 1)
//   --crf <n>               x264 CRF, lower = better quality/bigger (default: 22)
//   --preset <name>         x264 preset (default: slow)
//   --max-height <n>       downscale taller sources to this height (default: 1080)
//   --max-duration <sec>   reject sources longer than this (default: 30)
//   --deterministic         force -threads 1 for reproducible output bytes
//                           (same source -> same CID on re-run); slower.
//   --thumbnails            also extract + upload a poster frame per video
//   --upload                persist compressed output (+ thumbnail) to IPFS
//   --ipfsproxy <url>       ws://host:port or http(s)://host:port (default: ws://localhost:7071)
//   --jwt <token>           bearer token (default: JWT_ACCESS_TOKEN env var, else the
//                           shared dev token already hardcoded in the sibling seed scripts)
//   --host <host>           X-Forwarded-Host for http(s) uploads (default: api.dev.microfrmr.com)
//   --job-timeout <ms>      per-file ffmpeg/ffprobe/upload timeout (default: 600000)
//   --force                 ignore manifest, reprocess everything
//   --dry-run               probe + plan only, no encode/upload/writes
//
// Examples:
//   node examplecompressbulk.js --thumbnails --upload
//   node examplecompressbulk.js --in /ipfsseed/samples --ipfsproxy http://ipfs-proxy:7071 --upload
//   node examplecompressbulk.js --deterministic --concurrency 1 --dry-run

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');

const videoCompressor = require('./lib/videoCompressor');

const rawArgs = require('minimist')(process.argv.slice(2));

// Same dev-only fixed token the other ipfsseed/*.js clients ship with
// (ws_queryipfs.js, http_queryipfs.js). Override via --jwt or env for
// anything beyond local docker-compose.
const DEFAULT_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzZXJfMTIzNDUiLCJlbWFpbCI6ImFsZXhAZXhhbXBsZS5jb20iLCJwdWJsaWNLZXkiOiJldGNldGMiLCJyb2xlcyI6WyJ1c2VyIl0sImlhdCI6MTc4NTcxMzY3OSwiZXhwIjoxNzg4MzA1Njc5fQ.KW0hN8XpaoeKB7q9-DYPEhhkHMPyzHUIBrUZIWjAf1w';

const CONFIG = {
  in: rawArgs['in'] || path.join(__dirname, 'samples'),
  out: rawArgs['out'] || path.join(__dirname, 'compressed'),
  manifest: rawArgs['manifest'] || path.join(__dirname, 'manifest.json'),
  recursive: Boolean(rawArgs['recursive']),
  concurrency: toInt(rawArgs['concurrency'], Math.max(1, Math.floor(os.cpus().length / 4))),
  crf: toInt(rawArgs['crf'], 22),
  preset: rawArgs['preset'] || 'slow',
  maxHeight: toInt(rawArgs['max-height'], 1080),
  maxDurationSec: toFloat(rawArgs['max-duration'], 30),
  deterministic: Boolean(rawArgs['deterministic']),
  thumbnails: Boolean(rawArgs['thumbnails']),
  upload: Boolean(rawArgs['upload']),
  ipfsproxy: rawArgs['ipfsproxy'] || 'ws://localhost:7071',
  jwt: rawArgs['jwt'] || process.env.JWT_ACCESS_TOKEN || DEFAULT_JWT,
  host: rawArgs['host'] || 'api.dev.microfrmr.com',
  jobTimeoutMs: toInt(rawArgs['job-timeout'], 10 * 60 * 1000),
  force: Boolean(rawArgs['force']),
  dryRun: Boolean(rawArgs['dry-run']),
  ffmpegBin: process.env.FFMPEG_PATH || rawArgs['ffmpeg'] || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_PATH || rawArgs['ffprobe'] || 'ffprobe',
};

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function toFloat(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

async function preflightCheck() {
  try {
    await videoCompressor.checkBinaries({ ffmpegBin: CONFIG.ffmpegBin, ffprobeBin: CONFIG.ffprobeBin });
  } catch (err) {
    console.error(`Preflight failed: ${err.message}`);
    console.error('Install ffmpeg (e.g. `brew install ffmpeg` / `apt-get install -y ffmpeg`), or point --ffmpeg/--ffprobe (or FFMPEG_PATH/FFPROBE_PATH) at existing binaries.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// hashing (content-addressed manifest key, streamed — no full-file buffering)
// ---------------------------------------------------------------------------

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ---------------------------------------------------------------------------
// directory walk
// ---------------------------------------------------------------------------

async function collectFiles(dir, recursive) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...(await collectFiles(full, recursive)));
      continue;
    }
    if (videoCompressor.VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// upload — mirrors importbulk.js (ws) / http_queryipfs.js (http) contracts
// ---------------------------------------------------------------------------

// Node's dual-stack connect (tried on a refused/unreachable ws:// host)
// rejects with an AggregateError whose top-level .message is "" — the real
// reason lives in .errors[]. Normalize to a real message so callers logging
// err.message don't get a silently blank reason.
function describeError(err) {
  if (!err) return String(err);
  if (err.message) return err.message;
  if (Array.isArray(err.errors) && err.errors.length) {
    return err.errors.map((e) => e && e.message).filter(Boolean).join('; ') || String(err);
  }
  return err.code || String(err);
}

function uploadWs(baseUrl, buffer) {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl.replace(/\/+$/, '')}/persist`;
    const ws = new WebSocket(url, ['Bearer', CONFIG.jwt], { perMessageDeflate: true });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('upload timed out (ws)'));
    }, CONFIG.jobTimeoutMs);

    ws.on('open', () => ws.send(buffer));
    ws.on('message', (data) => {
      clearTimeout(timer);
      const cid = data.toString();
      ws.close();
      resolve(cid);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(describeError(err)));
    });
  });
}

async function uploadHttp(baseUrl, buffer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.jobTimeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/fs/persist`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.jwt}`,
        'X-Forwarded-Host': CONFIG.host,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`persist failed: HTTP ${response.status}`);
    return (await response.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

function uploadOne(buffer) {
  return CONFIG.ipfsproxy.startsWith('ws') ? uploadWs(CONFIG.ipfsproxy, buffer) : uploadHttp(CONFIG.ipfsproxy, buffer);
}

// ---------------------------------------------------------------------------
// manifest (resume support, content-addressed by source sha256)
// ---------------------------------------------------------------------------

async function loadManifest(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.files ? parsed : { version: 1, files: {} };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Warning: could not read manifest (${err.message}), starting fresh`);
    return { version: 1, files: {} };
  }
}

async function saveManifest(file, manifest) {
  manifest.updatedAt = new Date().toISOString();
  // Unique per call so two overlapping writers (see flush()'s serialization
  // note below) can never collide on the same temp path.
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2));
  await fsp.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// per-file pipeline
// ---------------------------------------------------------------------------

async function processOne(filePath, manifest) {
  const name = path.basename(filePath);
  const base = { sourcePath: filePath, sourceName: name };

  let sourceHash;
  try {
    sourceHash = await hashFile(filePath);
  } catch (err) {
    return { ...base, status: 'failed', stage: 'hash', reason: `hash: ${err.message}` };
  }

  const existing = manifest.files[sourceHash];
  if (existing && !CONFIG.force && (existing.status === 'compressed' || existing.status === 'skipped_duration')) {
    console.log(`[skip:resume] ${name} — already processed (${existing.status})`);
    return { ...existing, sourcePath: filePath, sourceName: name, resumed: true };
  }

  let info;
  try {
    info = await videoCompressor.probe(filePath, { ffprobeBin: CONFIG.ffprobeBin, timeoutMs: CONFIG.jobTimeoutMs });
  } catch (err) {
    console.error(`[error] ${name}: ffprobe failed — ${err.message}`);
    return { ...base, sourceHash, status: 'failed', stage: 'probe', reason: `probe: ${err.message}` };
  }

  // Hard requirement: reject anything over the duration cap before any
  // encoding is attempted. Recorded in the manifest so a resumed run
  // doesn't re-probe it, but never uploaded or compressed.
  if (info.durationSec > CONFIG.maxDurationSec) {
    console.error(
      `[error] ${name}: duration ${info.durationSec.toFixed(1)}s exceeds --max-duration ${CONFIG.maxDurationSec}s — skipped`
    );
    return {
      ...base,
      sourceHash,
      status: 'skipped_duration',
      stage: 'duration-check',
      reason: `duration ${info.durationSec.toFixed(1)}s > ${CONFIG.maxDurationSec}s`,
      durationSec: info.durationSec,
    };
  }

  if (CONFIG.dryRun) {
    console.log(`[dry-run] ${name}: ${info.durationSec.toFixed(1)}s, ${info.width}x${info.height} — would compress`);
    return { ...base, sourceHash, status: 'dry_run', durationSec: info.durationSec };
  }

  const sourceBytes = (await fsp.stat(filePath)).size;
  const outputPath = path.join(CONFIG.out, `${path.parse(name).name}.mp4`);

  try {
    await videoCompressor.compress(filePath, outputPath, info, {
      ffmpegBin: CONFIG.ffmpegBin,
      timeoutMs: CONFIG.jobTimeoutMs,
      crf: CONFIG.crf,
      preset: CONFIG.preset,
      maxHeight: CONFIG.maxHeight,
      deterministic: CONFIG.deterministic,
    });
  } catch (err) {
    console.error(`[error] ${name}: ffmpeg failed — ${err.message}`);
    await fsp.rm(outputPath, { force: true });
    return { ...base, sourceHash, status: 'failed', stage: 'encode', reason: `encode: ${err.message}`, durationSec: info.durationSec };
  }

  let finalPath = outputPath;
  let usedOriginal = false;
  const compressedBytes = (await fsp.stat(outputPath)).size;
  if (compressedBytes >= sourceBytes) {
    // Never ship a file worse than the source.
    console.log(`[info] ${name}: compressed (${compressedBytes}B) >= source (${sourceBytes}B), keeping original`);
    await fsp.rm(outputPath, { force: true });
    finalPath = filePath;
    usedOriginal = true;
  }
  const outputBytes = usedOriginal ? sourceBytes : compressedBytes;

  let thumbPath = null;
  if (CONFIG.thumbnails) {
    thumbPath = path.join(CONFIG.out, `${path.parse(name).name}.thumb.jpg`);
    try {
      await videoCompressor.extractThumbnail(filePath, thumbPath, info.durationSec, {
        ffmpegBin: CONFIG.ffmpegBin,
        timeoutMs: 30000,
      });
    } catch (err) {
      console.error(`[warn] ${name}: thumbnail extraction failed — ${err.message}`);
      thumbPath = null;
    }
  }

  let cid = null;
  let thumbnailCid = null;
  if (CONFIG.upload) {
    try {
      cid = await uploadOne(await fsp.readFile(finalPath));
    } catch (err) {
      console.error(`[error] ${name}: upload failed — ${err.message}`);
      return {
        ...base,
        sourceHash,
        status: 'failed',
        stage: 'upload',
        reason: `upload: ${err.message}`,
        durationSec: info.durationSec,
        width: info.width,
        height: info.height,
        outputPath: finalPath,
        sourceBytes,
        outputBytes,
        usedOriginal,
      };
    }
    if (thumbPath) {
      try {
        thumbnailCid = await uploadOne(await fsp.readFile(thumbPath));
      } catch (err) {
        console.error(`[warn] ${name}: thumbnail upload failed — ${err.message}`);
      }
    }
  }

  console.log(
    `[ok] ${name}: ${sourceBytes}B -> ${outputBytes}B (${(100 * (1 - outputBytes / sourceBytes)).toFixed(1)}% smaller)${cid ? `, cid=${cid}` : ''}`
  );

  return {
    ...base,
    sourceHash,
    status: 'compressed',
    durationSec: info.durationSec,
    width: info.width,
    height: info.height,
    outputPath: finalPath,
    usedOriginal,
    sourceBytes,
    outputBytes,
    cid,
    thumbnailPath: thumbPath,
    thumbnailCid,
    finishedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// bounded concurrency pool
// ---------------------------------------------------------------------------

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, next);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log('examplecompressbulk config:', {
    in: CONFIG.in,
    out: CONFIG.out,
    manifest: CONFIG.manifest,
    concurrency: CONFIG.concurrency,
    crf: CONFIG.crf,
    preset: CONFIG.preset,
    maxHeight: CONFIG.maxHeight,
    maxDurationSec: CONFIG.maxDurationSec,
    deterministic: CONFIG.deterministic,
    thumbnails: CONFIG.thumbnails,
    upload: CONFIG.upload,
    ipfsproxy: CONFIG.upload ? CONFIG.ipfsproxy : '(uploads disabled)',
    dryRun: CONFIG.dryRun,
  });

  await preflightCheck();

  if (!CONFIG.dryRun) await fsp.mkdir(CONFIG.out, { recursive: true });

  let files;
  try {
    files = await collectFiles(CONFIG.in, CONFIG.recursive);
  } catch (err) {
    console.error(`Cannot read --in directory '${CONFIG.in}': ${err.message}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log(`No video files found under ${CONFIG.in} (recursive=${CONFIG.recursive})`);
    return;
  }
  console.log(`Found ${files.length} candidate file(s)`);

  const manifest = await loadManifest(CONFIG.manifest);

  // Flush progress incrementally so a crash/Ctrl+C mid-run doesn't lose
  // already-completed work on the next resume.
  let dirty = false;
  // runPool's workers call flush() concurrently — every completed file
  // triggers one. Chaining onto a single promise serializes the actual
  // writes so two workers can never both be mid saveManifest() at once
  // (that raced on manifest.json.tmp and crashed with ENOENT on rename).
  let flushChain = Promise.resolve();
  const flush = () => {
    flushChain = flushChain.then(async () => {
      if (dirty && !CONFIG.dryRun) {
        dirty = false;
        await saveManifest(CONFIG.manifest, manifest);
      }
    });
    return flushChain;
  };
  const sigintHandler = async () => {
    console.log('\nInterrupted — flushing manifest...');
    await flush();
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  const results = await runPool(files, CONFIG.concurrency, async (filePath) => {
    const result = await processOne(filePath, manifest);
    if (result.sourceHash && !CONFIG.dryRun) {
      manifest.files[result.sourceHash] = result;
      dirty = true;
      await flush();
    }
    return result;
  });

  process.removeListener('SIGINT', sigintHandler);
  await flush();

  // ---- summary ----
  const compressed = results.filter((r) => r.status === 'compressed');
  const skippedDuration = results.filter((r) => r.status === 'skipped_duration');
  const failed = results.filter((r) => r.status === 'failed');
  const resumed = results.filter((r) => r.resumed);
  const uploaded = results.filter((r) => r.cid);

  const sourceBytes = compressed.reduce((sum, r) => sum + (r.sourceBytes || 0), 0);
  const outputBytes = compressed.reduce((sum, r) => sum + (r.outputBytes || 0), 0);

  console.log('\n=== examplecompressbulk summary ===');
  console.table({
    total: { count: files.length },
    compressed: { count: compressed.length },
    'skipped (>30s)': { count: skippedDuration.length },
    failed: { count: failed.length },
    'resumed (already done)': { count: resumed.length },
    uploaded: { count: uploaded.length },
  });

  if (compressed.length > 0) {
    const savedPct = sourceBytes > 0 ? (100 * (1 - outputBytes / sourceBytes)).toFixed(1) : '0.0';
    console.log(`Bytes: ${sourceBytes} -> ${outputBytes} (${savedPct}% saved)`);
  }
  if (skippedDuration.length > 0) {
    console.log('\nSkipped for exceeding --max-duration:');
    for (const r of skippedDuration) console.log(`  - ${r.sourceName}: ${r.reason}`);
  }
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const r of failed) console.log(`  - ${r.sourceName}: ${r.reason}`);
  }
  console.log(`\nManifest: ${CONFIG.manifest}`);

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
