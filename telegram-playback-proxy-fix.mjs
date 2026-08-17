import express from "express";

// Cloud Run / reverse proxies terminate TLS before Node sees the request.
// Make Express trust the forwarded protocol so generated Telegram stream URLs
// are HTTPS instead of HTTP (which browsers block as mixed content).
const originalListen = express.application.listen;
if (!express.application.__indoPlaybackProxyFix) {
  express.application.__indoPlaybackProxyFix = true;
  express.application.listen = function indoPlaybackProxyFixListen(...args) {
    this.set("trust proxy", true);
    return originalListen.apply(this, args);
  };
}
