import express from "express";

const originalUse = express.application.use;

express.application.use = function secureUse(...args) {
  return originalUse.call(this, ...args);
};

const originalHandle = express.application.handle;
express.application.handle = function securityHeadersHandle(req, res, done) {
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none';");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  // Video/audio files are intentionally consumed by the separate frontend origin.
  // same-origin blocks <video> requests and produces ERR_BLOCKED_BY_RESPONSE.NotSameOrigin.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return originalHandle.call(this, req, res, done);
};
