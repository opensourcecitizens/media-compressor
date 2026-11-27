'use strict';

// config.js — the same dev-only constants js/examples/html's pages
// hardcode (same JWT, same host, same local proxy ports) so this example
// is directly comparable to its web counterpart. Not meant to work
// against anything but a local docker-compose proxy — see
// js/examples/html/README.md's "Shared quirks" section.

export const JWT_ACCESS_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzZXJfMTIzNDUiLCJlbWFpbCI6ImFsZXhAZXhhbXBsZS5jb20iLCJwdWJsaWNLZXkiOiJldGNldGMiLCJyb2xlcyI6WyJ1c2VyIl0sImlhdCI6MTc4NTcxMzY3OSwiZXhwIjoxNzg4MzA1Njc5fQ.KW0hN8XpaoeKB7q9-DYPEhhkHMPyzHUIBrUZIWjAf1w';
export const HOST = 'api.dev.microfrmr.com';

export const HTTP_RETRIEVE_URL = 'http://localhost:9090/fs/retrieve';
export const HTTP_PERSIST_URL = 'http://localhost:9090/fs/persist';
export const WS_RETRIEVE_URL = 'ws://localhost:7071/retrieve';
export const WS_PERSIST_URL = 'ws://localhost:7071/persist';

export const MAX_UPLOAD_VIDEO_DURATION_SEC = 30; // same hard rule as the Node/web examples' --max-duration default
