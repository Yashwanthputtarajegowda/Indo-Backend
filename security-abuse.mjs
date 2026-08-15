import crypto from "node:crypto";
import rateLimit from "express-rate-limit";

const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many actions. Please try again later." },
});

const commentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many comments. Please try again later." },
});

const followLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many follow actions. Please try again later." },
});

function tokenKey(req) {
  const header = String(req.headers.authorization || "");
  if (!/^Bearer\s+\S+$/i.test(header)) return null;
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  return `auth:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

function actionLimiterFor(path) {
  if (/\/comments(?:\/|$)/.test(path)) return commentLimiter;
  if (/\/follow(?:-requests)?(?:\/|$)/.test(path)) return followLimiter;
  if (/\/(?:like|save|share|view)(?:\/|$)/.test(path)) return mutationLimiter;
  return null;
}

const originalUse = appUse;

export function installAbuseGuards(app) {
  app.use((req, res, next) => {
    const limiter = actionLimiterFor(String(req.path || ""));
    if (!limiter) return next();
    const originalIp = req.ip;
    const authKey = tokenKey(req);
    if (authKey) {
      const saved = req.ip;
      Object.defineProperty(req, "ip", { configurable: true, value: authKey });
      return limiter(req, res, () => {
        Object.defineProperty(req, "ip", { configurable: true, value: saved });
        next();
      });
    }
    return limiter(req, res, next);
  });
}
