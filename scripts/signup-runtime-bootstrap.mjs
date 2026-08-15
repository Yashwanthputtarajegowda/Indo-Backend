// Stable production entrypoint.
// Keep the existing npm start contract, but run the real Express server directly.
// No Express prototype monkey-patches or DOM-style bootstrap layers are used.
await import("../server.js");
