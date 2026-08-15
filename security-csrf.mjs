import express from "express";

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_ALLOWED = new Set([
  "https://yashwanthputtarajegowda.github.io",
  "http://localhost:5173",
  "http://localhost:3000",
]);

function allowedOrigins() {
  const configured = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((x) => x.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED, ...configured]);
}

const originalUse = express.application.use;
express.application.use = function secureUse(...args) {
  if (!this.__indoCsrfGuardInstalled) {
    this.__indoCsrfGuardInstalled = true;
    originalUse.call(this, (req, res, next) => {
      if (!STATE_CHANGING.has(String(req.method || "").toUpperCase())) return next();

      const origin = String(req.headers.origin || "").trim().replace(/\/$/, "");
      // Non-browser clients commonly omit Origin. Bearer-token APIs do not use cookies,
      // so an absent Origin is not a CSRF signal by itself.
      if (!origin) return next();

      if (!allowedOrigins().has(origin)) {
        return res.status(403).json({ ok: false, error: "Origin is not allowed." });
      }
      return next();
    });
  }
  return originalUse.call(this, ...args);
};
