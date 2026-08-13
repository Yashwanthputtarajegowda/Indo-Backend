// Stable production entrypoint.
// Canonical migration and story compatibility run first; server.js
// mounts the real account claim router directly.
await import("./force-canonical-bootstrap.mjs");
