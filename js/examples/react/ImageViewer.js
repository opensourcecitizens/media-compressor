'use strict';

// examples/react/ImageViewer.js — EXAMPLE code: one way to build a React
// component on top of media-compressor-js, not a module the package
// itself ships or exports. Ported from a Next.js app's web/components/
// ImageViewer.js (itself ported from mobile/components/ImageHandler.js's
// ImageViewer). Same idea: fetch `imageCid`'s bytes from somewhere, sniff
// the magic bytes to tell image from video, then render it as a Blob
// object URL.
//
// Deliberate differences from the app it was ported from:
//   - No "use client" directive — that's Next.js App Router-specific and
//     meaningless (though harmless) outside it. A consumer using the App
//     Router can wrap this in their own 'use client' re-export if needed.
//   - No built-in knowledge of ws/http/IPFS at all. The app version had a
//     `transport` prop that switched between two inline fetch
//     implementations; this version takes a single `fetchMedia` function
//     instead — (id, { onBytes, onError }) => cancelFn — so the component
//     doesn't need to know what "transport" even means. See fetchers.js
//     for the two built-in implementations (ws/http, the same ones the
//     app version had inline) that cover the common case; anything else
//     (a REST API, a different protocol, a test mock) is just a different
//     function.
//   - detectMime/toHex are NOT duplicated here a fourth time — imported
//     from the real media-compressor-js package's mediaDetect module
//     (the same canonical implementation the IpfsConnector classes in
//     ../lib/connectors already delegate to), the way any consumer of
//     this package would, not a relative reach into its source.
//
// No JSX: this example is plain React.createElement calls rather than
// JSX syntax, so it stays directly requireable/checkable with `node
// --check` without a build step — see ../package.json, which has none.
// Functionally identical to JSX — JSX compiles down to exactly these
// calls.
//
// Verified with react-test-renderer against both built-in fetchers and
// the direct-url path (a devDependency of examples/, not of the package
// itself — see fetchers.js's factories for what's actually exercised).
// Not rendered in a real browser/app.

const React = require('react');
const { useEffect, useState } = React;
const { detectMime } = require('media-compressor/browser/mediaDetect');

/** Resolves `id` via `fetchMedia` to a blob object URL + media type. */
function useCidMedia(id, fetchMedia) {
  const [mediaUrl, setMediaUrl] = useState(null);
  const [mediaType, setMediaType] = useState(null); // 'image' | 'video'
  const [status, setStatus] = useState(id ? 'loading' : 'empty');

  useEffect(() => {
    if (!id) return;

    let objectUrl = null;
    setStatus('loading');

    const onBytes = (bytes) => {
      const mime = detectMime(bytes);
      if (!mime) {
        setStatus('error');
        return;
      }
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      setMediaUrl(objectUrl);
      setMediaType(mime.startsWith('video') ? 'video' : 'image');
      setStatus('ready');
    };

    const onError = () => setStatus('error');

    const cancel = fetchMedia(id, { onBytes, onError });

    return () => {
      cancel();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fetchMedia]);

  return { mediaUrl, mediaType, status };
}

/**
 * Renders an image or video, either from a directly-supplied `url` (skips
 * fetching entirely) or by resolving `imageCid` through `fetchMedia`.
 *
 * Props: imageCid, url, className, alt, fetchMedia ((id, { onBytes,
 * onError }) => cancelFn — required whenever `imageCid` is used without
 * `url`; see fetchers.js for createWsFetcher/createHttpFetcher).
 *
 * `fetchMedia` is an effect dependency: pass a stable reference (e.g. the
 * result of createWsFetcher/createHttpFetcher held in a useMemo, or
 * module-level if its config never changes) rather than calling a factory
 * inline in JSX — a new function identity every render would otherwise
 * re-fetch every render.
 */
function ImageViewer({ imageCid, url, className, alt = '', fetchMedia }) {
  // A directly-supplied `url` needs no fetch - render it straight away and
  // skip the CID hook/effect entirely.
  const cidMedia = useCidMedia(url ? null : imageCid, fetchMedia);
  const status = url ? 'ready' : cidMedia.status;
  const mediaUrl = url || cidMedia.mediaUrl;
  const mediaType = url ? 'image' : cidMedia.mediaType;

  if (status === 'loading') {
    return React.createElement('div', { className: `media-placeholder ${className || ''}` }, 'Retrieving media…');
  }
  if (status === 'error') {
    return React.createElement('div', { className: `media-placeholder ${className || ''}` }, 'Could not retrieve media');
  }
  if (status === 'empty') {
    return React.createElement('div', { className: `media-placeholder ${className || ''}` }, 'No media');
  }
  if (mediaType === 'video') {
    return React.createElement('video', { src: mediaUrl, className, controls: true });
  }
  return React.createElement('img', { src: mediaUrl, alt, className });
}

module.exports = ImageViewer;
module.exports.default = ImageViewer;
