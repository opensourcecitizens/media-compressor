#!/usr/bin/env node
'use strict';

// importcompressedbulk.js — bulk import for a directory of mixed image + video files:
// probes each, compresses it with the matching library (lib/videoCompressor.js
// or lib/imageCompressor.js), and optionally uploads the result to IPFS via
// the ipfs-proxy.
//
// This is the mixed-media counterpart to examplecompressbulk.js (video-only, kept
// for callers that only ever deal in video). Both files now share the same
// compression logic through lib/videoCompressor.js so encode behavior can't
// drift between the two entry points.
//
// File-type dispatch is by extension (lib/videoCompressor.js's
// VIDEO_EXTENSIONS / lib/imageCompressor.js's IMAGE_EXTENSIONS). Anything
// else is recorded as skipped_unsupported and left alone.
//
// Videos carry the same hard rule as examplecompressbulk.js: anything longer than
// --max-duration seconds (default 30) is probed, logged as an error, and
// skipped — never encoded, never uploaded. Images have no duration concept
// and are never subject to this check.
//
// Usage:
//   node importcompressedbulk.js [options]
//
// Shared options:
//   --in <dir>            source directory (default: ./samples)
//   --out <dir>            compressed-output directory (default: ./imported)
//   --manifest <file>      resume/progress manifest (default: ./import-manifest.json)
//   --recursive            walk --in recursively (default: false)
//   --concurrency <n>      parallel compression jobs (default: cpus/4, min 1)
//   --job-timeout <ms>      per-file probe/encode/upload timeout (default: 600000)
//   --thumbnails            also extract + upload a small preview per file
//                           (video: poster JPEG frame; image: downscaled WebP)
//   --upload                persist compressed output (+ thumbnail) to IPFS
//   --ipfsproxy <url>       ws://host:port or http(s)://host:port (default: ws://localhost:7071)
//   --jwt <token>           bearer token (default: JWT_ACCESS_TOKEN env var, else the
//                           shared dev token already hardcoded in the sibling seed scripts)
//   --host <host>           X-Forwarded-Host for http(s) uploads (default: api.dev.microfrmr.com)
//   --force                 ignore manifest, reprocess everything
//   --dry-run               probe + plan only, no encode/upload/writes
//
// Video options:
//   --crf <n>               x264 CRF, lower = better quality/bigger (default: 22)
//   --preset <name>         x264 preset (default: slow)
//   --max-height <n>       downscale taller sources to this height (default: 1080)
//   --max-duration <sec>   reject videos longer than this (default: 30)
//   --deterministic         force -threads 1 for reproducible output bytes
//
// Image options:
//   --image-quality <n>    libwebp quality 0-100 (default: 80)
//   --image-max-dim <n>    downscale longest edge past this (default: 1920)
//   --thumb-max-dim <n>    image thumbnail longest edge (default: 320)
//
// Examples:
//   node importcompressedbulk.js --thumbnails --upload
//   node importcompressedbulk.js --in /ipfsseed/samples --ipfsproxy http://ipfs-proxy:7071 --upload
//   node importcompressedbulk.js --dry-run --recursive

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');

const { videoCompressor, imageCompressor } = require('media-compressor');

const rawArgs = require('minimist')(process.argv.slice(2));

// Same dev-only fixed token the other ipfsseed/*.js clients ship with
// (ws_queryipfs.js, http_queryipfs.js, examplecompressbulk.js).
//const DEFAULT_JWT =
//  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzZXJfMTIzNDUiLCJlbWFpbCI6ImFsZXhAZXhhbXBsZS5jb20iLCJwdWJsaWNLZXkiOiJldGNldGMiLCJyb2xlcyI6WyJ1c2VyIl0sImlhdCI6MTc4NTcxMzY3OSwiZXhwIjoxNzg4MzA1Njc5fQ.KW0hN8XpaoeKB7q9-DYPEhhkHMPyzHUIBrUZIWjAf1w';
const DEFAULT_JWT='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzZXJfMTIzNDUiLCJlbWFpbCI6ImFsZXhAZXhhbXBsZS5jb20iLCJwdWJsaWNLZXkiOiJldGNldGMiLCJyb2xlcyI6WyJ1c2VyIl0sImlhdCI6MTc4NTYzODY1OSwiZXhwIjoxNzkwODIyNjU5fQ.eboYRr4LRWcnXFig0zMWkWvZY2a43lYLRhJUiBkbbCw'

const CONFIG = {
  in: rawArgs['in'] || path.join(__dirname, 'samples'),
  out: rawArgs['out'] || path.join(__dirname, 'imported'),
  manifest: rawArgs['manifest'] || path.join(__dirname, 'import-manifest.json'),
  recursive: Boolean(rawArgs['recursive']),
  concurrency: toInt(rawArgs['concurrency'], Math.max(1, Math.floor(os.cpus().length / 4))),
  jobTimeoutMs: toInt(rawArgs['job-timeout'], 10 * 60 * 1000),
  thumbnails: Boolean(rawArgs['thumbnails']),
  upload: Boolean(rawArgs['upload']),
  ipfsproxy: rawArgs['ipfsproxy'] || 'ws://localhost:7071/fs',
  jwt: rawArgs['jwt'] || DEFAULT_JWT,
  host: rawArgs['host'] || 'api.dev.microfrmr.com',
  force: Boolean(rawArgs['force']),
  dryRun: Boolean(rawArgs['dry-run']),
  ffmpegBin: process.env.FFMPEG_PATH || rawArgs['ffmpeg'] || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_PATH || rawArgs['ffprobe'] || 'ffprobe',

  crf: toInt(rawArgs['crf'], 22),
  preset: rawArgs['preset'] || 'slow',
  maxHeight: toInt(rawArgs['max-height'], 1080),
  maxDurationSec: toFloat(rawArgs['max-duration'], 30),
  deterministic: Boolean(rawArgs['deterministic']),

  imageQuality: toInt(rawArgs['image-quality'], 80),
  imageMaxDim: toInt(rawArgs['image-max-dim'], 1920),
  thumbMaxDim: toInt(rawArgs['thumb-max-dim'], 320),
};

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function toFloat(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Tags an error with which pipeline stage threw it (probe/encode/upload/...)
// so a failure in processVideo/processImage carries the same stage
// granularity examplecompressbulk.js's inline try/catches already have,
// instead of processOne's catch-all collapsing "bad input file" and
// "ffmpeg rejected an option" into an identical-looking failure. `.stage`
// is read back in processOne below and stored on the manifest entry
// alongside `reason`, so failures are filterable by stage
// (`jq '.files[] | select(.stage=="upload")'`) without parsing the message.
function stageError(stage, err) {
  const wrapped = new Error(`${stage}: ${err.message}`);
  wrapped.stage = stage;
  wrapped.cause = err;
  return wrapped;
}

function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (videoCompressor.VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (imageCompressor.IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
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
// directory walk — collects every file (not just recognized extensions) so
// unsupported types are visible in the summary rather than silently dropped
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
    out.push(full);
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

async function processVideo(filePath, name, sourceHash, sourceBytes) {
  const info = await videoCompressor
    .probe(filePath, { ffprobeBin: CONFIG.ffprobeBin, timeoutMs: CONFIG.jobTimeoutMs })
    .catch((err) => { throw stageError('probe', err); });

  // Hard requirement: reject anything over the duration cap before any
  // encoding is attempted.
  if (info.durationSec > CONFIG.maxDurationSec) {
    console.error(
      `[error] ${name}: duration ${info.durationSec.toFixed(1)}s exceeds --max-duration ${CONFIG.maxDurationSec}s — skipped`
    );
    return {
      mediaType: 'video',
      sourceHash,
      status: 'skipped_duration',
      stage: 'duration-check',
      reason: `duration ${info.durationSec.toFixed(1)}s > ${CONFIG.maxDurationSec}s`,
      durationSec: info.durationSec,
    };
  }

  if (CONFIG.dryRun) {
    console.log(`[dry-run] ${name} (video): ${info.durationSec.toFixed(1)}s, ${info.width}x${info.height} — would compress`);
    return { mediaType: 'video', sourceHash, status: 'dry_run', durationSec: info.durationSec };
  }

  const outputPath = path.join(CONFIG.out, `${path.parse(name).name}.mp4`);
  await videoCompressor.compress(filePath, outputPath, info, {
    ffmpegBin: CONFIG.ffmpegBin,
    timeoutMs: CONFIG.jobTimeoutMs,
    crf: CONFIG.crf,
    preset: CONFIG.preset,
    maxHeight: CONFIG.maxHeight,
    deterministic: CONFIG.deterministic,
  }).catch((err) => { throw stageError('encode', err); });

  let finalPath = outputPath;
  let usedOriginal = false;
  const compressedBytes = (await fsp.stat(outputPath)).size;
  if (compressedBytes >= sourceBytes) {
    console.log(`[info] ${name}: compressed (${compressedBytes}B) >= source (${sourceBytes}B), keeping original`);
    await fsp.rm(outputPath, { force: true });
    finalPath = filePath;
    usedOriginal = true;
  }

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

  return {
    mediaType: 'video',
    sourceHash,
    status: 'compressed',
    durationSec: info.durationSec,
    width: info.width,
    height: info.height,
    outputPath: finalPath,
    usedOriginal,
    outputBytes: usedOriginal ? sourceBytes : compressedBytes,
    thumbnailPath: thumbPath,
  };
}

async function processImage(filePath, name, sourceHash, sourceBytes) {
  const info = await imageCompressor
    .probe(filePath, { ffprobeBin: CONFIG.ffprobeBin, timeoutMs: CONFIG.jobTimeoutMs })
    .catch((err) => { throw stageError('probe', err); });

  if (CONFIG.dryRun) {
    console.log(`[dry-run] ${name} (image): ${info.width}x${info.height}${info.isAnimated ? ', animated' : ''} — would compress`);
    return { mediaType: 'image', sourceHash, status: 'dry_run', width: info.width, height: info.height };
  }

  // requestedOutputPath's extension is a placeholder — imageCompressor picks
  // the real one (webp if the ffmpeg build supports it, otherwise a jpg/png/
  // gif fallback; see lib/imageCompressor.js) and hands back the path it
  // actually wrote.
  const requestedOutputPath = path.join(CONFIG.out, `${path.parse(name).name}.webp`);
  const encodeResult = await imageCompressor.compress(filePath, requestedOutputPath, info, {
    ffmpegBin: CONFIG.ffmpegBin,
    timeoutMs: CONFIG.jobTimeoutMs,
    quality: CONFIG.imageQuality,
    maxDim: CONFIG.imageMaxDim,
  }).catch((err) => { throw stageError('encode', err); });
  const outputPath = encodeResult.outputPath;

  let finalPath = outputPath;
  let usedOriginal = false;
  const compressedBytes = (await fsp.stat(outputPath)).size;
  if (compressedBytes >= sourceBytes) {
    console.log(`[info] ${name}: compressed (${compressedBytes}B) >= source (${sourceBytes}B), keeping original`);
    await fsp.rm(outputPath, { force: true });
    finalPath = filePath;
    usedOriginal = true;
  }

  let thumbPath = null;
  if (CONFIG.thumbnails) {
    const requestedThumbPath = path.join(CONFIG.out, `${path.parse(name).name}.thumb.webp`);
    try {
      const thumbResult = await imageCompressor.extractThumbnail(filePath, requestedThumbPath, info, {
        ffmpegBin: CONFIG.ffmpegBin,
        timeoutMs: 30000,
        maxDim: CONFIG.thumbMaxDim,
      });
      thumbPath = thumbResult.outputPath;
    } catch (err) {
      console.error(`[warn] ${name}: thumbnail extraction failed — ${err.message}`);
      thumbPath = null;
    }
  }

  return {
    mediaType: 'image',
    sourceHash,
    status: 'compressed',
    width: info.width,
    height: info.height,
    isAnimated: info.isAnimated,
    codec: encodeResult.codec,
    outputPath: finalPath,
    usedOriginal,
    outputBytes: usedOriginal ? sourceBytes : compressedBytes,
    thumbnailPath: thumbPath,
  };
}

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
  const RESUMABLE_STATUSES = new Set(['compressed', 'skipped_duration', 'skipped_unsupported']);
  if (existing && !CONFIG.force && RESUMABLE_STATUSES.has(existing.status)) {
    console.log(`[skip:resume] ${name} — already processed (${existing.status})`);
    return { ...existing, sourcePath: filePath, sourceName: name, resumed: true };
  }

  const mediaType = classify(filePath);
  if (!mediaType) {
    console.error(`[error] ${name}: unsupported file extension — skipped`);
    return { ...base, sourceHash, status: 'skipped_unsupported', stage: 'classify', reason: `unsupported extension '${path.extname(name)}'` };
  }

  const sourceBytes = (await fsp.stat(filePath)).size;

  let result;
  try {
    result = mediaType === 'video'
      ? await processVideo(filePath, name, sourceHash, sourceBytes)
      : await processImage(filePath, name, sourceHash, sourceBytes);
  } catch (err) {
    // err.stage comes from stageError() above (probe/encode) when
    // processVideo/processImage threw it; anything else (a bug in this
    // file itself, not the ffmpeg pipeline) falls back to 'process' rather
    // than silently losing stage info.
    console.error(`[error] ${name}: ${err.message}`);
    return { ...base, sourceHash, mediaType, status: 'failed', stage: err.stage || 'process', reason: err.message };
  }

  result = { ...base, sourceBytes, ...result };
  if (result.status !== 'compressed') return result;

  if (CONFIG.upload) {
    try {
      result.cid = await uploadOne(await fsp.readFile(result.outputPath));
    } catch (err) {
      console.error(`[error] ${name}: upload failed — ${err.message}`);
      return { ...result, status: 'failed', stage: 'upload', reason: `upload: ${err.message}` };
    }
    if (result.thumbnailPath) {
      try {
        result.thumbnailCid = await uploadOne(await fsp.readFile(result.thumbnailPath));
      } catch (err) {
        console.error(`[warn] ${name}: thumbnail upload failed — ${err.message}`);
      }
    }
  }

  const savedPct = result.sourceBytes > 0 ? (100 * (1 - result.outputBytes / result.sourceBytes)).toFixed(1) : '0.0';
  console.log(
    `[ok] ${name} (${mediaType}): ${result.sourceBytes}B -> ${result.outputBytes}B (${savedPct}% smaller)${result.cid ? `, cid=${result.cid}` : ''}`
  );

  result.finishedAt = new Date().toISOString();
  return result;
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
  console.log('importcompressedbulk config:', {
    in: CONFIG.in,
    out: CONFIG.out,
    manifest: CONFIG.manifest,
    concurrency: CONFIG.concurrency,
    thumbnails: CONFIG.thumbnails,
    upload: CONFIG.upload,
    ipfsproxy: CONFIG.upload ? CONFIG.ipfsproxy : '(uploads disabled)',
    dryRun: CONFIG.dryRun,
    video: { crf: CONFIG.crf, preset: CONFIG.preset, maxHeight: CONFIG.maxHeight, maxDurationSec: CONFIG.maxDurationSec, deterministic: CONFIG.deterministic },
    image: { quality: CONFIG.imageQuality, maxDim: CONFIG.imageMaxDim, thumbMaxDim: CONFIG.thumbMaxDim },
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
    console.log(`No files found under ${CONFIG.in} (recursive=${CONFIG.recursive})`);
    return;
  }
  console.log(`Found ${files.length} file(s)`);

  const manifest = await loadManifest(CONFIG.manifest);

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
  const compressedVideos = compressed.filter((r) => r.mediaType === 'video');
  const compressedImages = compressed.filter((r) => r.mediaType === 'image');
  const skippedDuration = results.filter((r) => r.status === 'skipped_duration');
  const skippedUnsupported = results.filter((r) => r.status === 'skipped_unsupported');
  const failed = results.filter((r) => r.status === 'failed');
  const resumed = results.filter((r) => r.resumed);
  const uploaded = results.filter((r) => r.cid);

  const sourceBytes = compressed.reduce((sum, r) => sum + (r.sourceBytes || 0), 0);
  const outputBytes = compressed.reduce((sum, r) => sum + (r.outputBytes || 0), 0);

  console.log('\n=== importcompressedbulk summary ===');
  console.table({
    total: { count: files.length },
    'compressed (video)': { count: compressedVideos.length },
    'compressed (image)': { count: compressedImages.length },
    'skipped (video >30s)': { count: skippedDuration.length },
    'skipped (unsupported type)': { count: skippedUnsupported.length },
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
  if (skippedUnsupported.length > 0) {
    console.log('\nSkipped (unsupported type):');
    for (const r of skippedUnsupported) console.log(`  - ${r.sourceName}: ${r.reason}`);
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
