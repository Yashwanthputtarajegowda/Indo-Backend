import express from "express";
import admin from "firebase-admin";

const MAX_AUTH_AGE_SECONDS = 15 * 60;
const SENSITIVE_ACCOUNT_PATHS = [
  "/api/account/contact",
  "/api/account/delete",
  "/api/account/email",
  "/api/account/mobile",
  "/api/account/credentials",
];

function isSensitiveAccountPath(path) {
  if (typeof path !== "string") return false;
  return SENSITIVE_ACCOUNT_PATHS.some(
    (entry) => path === entry || path.startsWith(`${entry}/`),
  );
}

async function requireRecentAuthentication(req, res, next) {
  const app = admin.apps.length ? admin.app() : null;
  if (!app) {
    return res.status(503).json({
      ok: false,
      error: "Authentication service is unavailable.",
    });
  }

  const header = String(req.headers.authorization || "");
  if (!/^Bearer\s+\S+$/i.test(header)) {
    return res.status(401).json({
      ok: false,
      error: "Recent authentication is required.",
    });
  }

  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token.length < 20 || token.length > 16384) {
    return res.status(401).json({
      ok: false,
      error: "Invalid authentication token.",
    });
  }

  try {
    const decoded = await admin.auth(app).verifyIdToken(token, true);
    const authTime = Number(decoded.auth_time || 0);
    const now = Math.floor(Date.now() / 1000);
    if (!authTime || now - authTime > MAX_AUTH_AGE_SECONDS) {
      return res.status(401).json({
        ok: false,
        error: "Recent authentication is required. Please sign in again.",
      });
    }
    req.recentAuthUser = decoded;
    return next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "Invalid or expired authentication token.",
    });
  }
}

function secureMethod(methodName) {
  const original = express.application[methodName];
  express.application[methodName] = function secureSensitiveAccountRoute(
    path,
    ...handlers
  ) {
    if (isSensitiveAccountPath(path)) {
      return original.call(this, path, requireRecentAuthentication, ...handlers);
    }
    return original.call(this, path, ...handlers);
  };
}

secureMethod("post");
secureMethod("patch");
secureMethod("delete");
