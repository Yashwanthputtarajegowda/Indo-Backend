import express from "express";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

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
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
    databaseURL,
  });
  return admin.auth(admin.app());
}

const auth = initAuth();
const db = admin.apps.length
  ? getDatabaseWithUrl(
      process.env.FIREBASE_DATABASE_URL ||
        "https://indo-174f0-default-rtdb.firebaseio.com",
      admin.app(),
    )
  : null;

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
      const limited = await new Promise((resolve) => {
        legacyViewLimiter(req, res, () => resolve(true));
      });
      if (!limited) return;
      if (!auth || !db)
        return res.status(503).json({ ok: false, error: "Authentication service is unavailable." });

      const header = String(req.headers.authorization || "");
      if (!/^Bearer\\s+\\S+$/i.test(header))
        return res.status(401).json({ ok: false, error: "Authentication required." });
      const token = header.replace(/^Bearer\\s+/i, "").trim();
      if (token.length < 20 || token.length > 16384)
        return res.status(401).json({ ok: false, error: "Invalid authentication token." });

      try {
        const user = await auth.verifyIdToken(token, true);
        req.securityUser = user;

        const videoId = String(req.params.videoId || "").trim();
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(videoId))
          return res.status(400).json({ ok: false, error: "Invalid video ID." });

        const videoRef = db.ref(`videos/${videoId}`);
        const snapshot = await videoRef.get();
        if (!snapshot.exists())
          return res.status(404).json({ ok: false, error: "Video not found." });

        const markerRef = db.ref(`videoViews/${videoId}/${user.uid}`);
        const marker = await markerRef.transaction((current) =>
          current ? current : { firstSeenAt: Date.now() },
        );
        if (!marker.committed || marker.snapshot.val()?.firstSeenAt !== marker.snapshot.val()?.firstSeenAt) {
          return res.status(409).json({ ok: false, error: "Could not record video view." });
        }
        const markerValue = marker.snapshot.val();
        if (markerValue?.firstSeenAt !== undefined && markerValue?.firstSeenAt !== null) {
          const createdNow = markerValue.firstSeenAt >= Date.now() - 1000;
          if (!createdNow) {
            return res.json({
              ok: true,
              videoId,
              views: Number(snapshot.val()?.views || 0),
              counted: false,
            });
          }
        }
        return next();
      } catch {
        return res.status(401).json({ ok: false, error: "Invalid or expired authentication token." });
      }
    };
    return originalPost.call(this, path, guard, ...handlers);
  }
  return originalPost.call(this, path, ...handlers);
};
