import express from "express";

const originalUse = express.application.use;

express.application.use = function secureUse(...args) {
  return originalUse.call(this, ...args);
};

const originalHandle = express.application.handle;
express.application.handle = function securityHeadersHandle(req, res, done) {
  // Helmet runs later in the middleware chain and otherwise resets this to
  // same-origin. Keep media resources usable from the separate frontend origin.
  if (!res.__indoMediaCorsPatched) {
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      if (String(name).toLowerCase() === "cross-origin-resource-policy" && String(value).toLowerCase() === "same-origin") {
        return originalSetHeader(name, "cross-origin");
      }
      return originalSetHeader(name, value);
    };
    res.__indoMediaCorsPatched = true;
  }

  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none';");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return originalHandle.call(this, req, res, done);
};
