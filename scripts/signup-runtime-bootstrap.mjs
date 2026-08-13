// Stable production entrypoint.
// Load video-owner metadata first, then canonical migration/story/server bootstrap.
await import("./pre-bootstrap-video-owner.mjs");
