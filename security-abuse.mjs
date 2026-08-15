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

function limiterFor(req) {
  const path = String(req.path || "");
  if (/\/comments(?:\/|$)/.test(path)) return commentLimiter;
  if (/\/follow(?:-requests)?(?:\/|$)/.test(path)) return followLimiter;
  if (/\/(?:like|save|share|view)(?:\/|$)/.test(path)) return mutationLimiter;
  return null;
}

export function installAbuseGuards(app) {
  app.use((req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    const limiter = limiterFor(req);
    if (!limiter) return next();

    const authKey = tokenKey(req);
    if (!authKey) return limiter(req, res, next);

    const originalIp = req.ip;
    try {
      Object.defineProperty(req, "ip", { configurable: true, value: authKey });
      return limiter(req, res, () => {
        Object.defineProperty(req, "ip", { configurable: true, value: originalIp });
        next();
      });
    } catch {
      return res.status(429).json({ ok: false, error: "Too many actions. Please try again later." });
    }
  });
}
