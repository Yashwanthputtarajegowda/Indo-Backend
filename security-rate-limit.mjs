import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";

function tokenKey(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return "anonymous";
  return crypto
    .createHash("sha256")
    .update(match[1])
    .digest("hex");
}

const mutationIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !["POST", "PATCH", "PUT", "DELETE"].includes(req.method),
  message: { ok: false, error: "Too many requests. Please try again later." },
});

const mutationIdentityLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: tokenKey,
  skip: (req) =>
    !["POST", "PATCH", "PUT", "DELETE"].includes(req.method) ||
    !/^Bearer\s+\S+$/i.test(String(req.headers.authorization || "")),
  message: { ok: false, error: "Too many authenticated requests. Please try again later." },
});

const originalUse = express.application.use;
express.application.use = function secureUse(path, ...handlers) {
  if (typeof path === "string" && path === "/api") {
    return originalUse.call(
      this,
      path,
      mutationIpLimiter,
      mutationIdentityLimiter,
      ...handlers,
    );
  }
  return originalUse.call(this, path, ...handlers);
};
