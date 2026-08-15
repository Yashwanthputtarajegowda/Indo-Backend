import express from "express";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";

function initAuth() {
  if (admin.apps.length) return admin.auth(admin.app());
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  const databaseURL =
    process.env.FIREBASE_DATABASE_URL ||
    "https://indo-174f0-default-rtdb.firebaseio.com";
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL,
  });
  return admin.auth(admin.app());
}

const auth = initAuth();

const legacyViewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many view requests. Please try again later." },
});

const originalPost = express.application.post;
express.application.post = function securePost(path, ...handlers) {
  if (path === "/api/media/videos/:videoId/view") {
    const guard = async (req, res, next) => {
      if (!auth)
        return res.status(503).json({ ok: false, error: "Authentication service is unavailable." });
      const header = String(req.headers.authorization || "");
      if (!/^Bearer\s+\S+$/i.test(header))
        return res.status(401).json({ ok: false, error: "Authentication required." });
      const token = header.replace(/^Bearer\s+/i, "").trim();
      if (token.length < 20 || token.length > 16384)
        return res.status(401).json({ ok: false, error: "Invalid authentication token." });
      try {
        req.securityUser = await auth.verifyIdToken(token, true);
      } catch {
        return res.status(401).json({ ok: false, error: "Invalid or expired authentication token." });
      }
      return next();
    };
    return originalPost.call(this, path, legacyViewLimiter, guard, ...handlers);
  }
  return originalPost.call(this, path, ...handlers);
};
