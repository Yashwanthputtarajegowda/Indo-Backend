import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { createTelegramChunkRouter } from "./services/telegram-chunk-storage.js";
import { canonicalUserRoot, syncCanonicalUser } from "./services/user-canonical.js";
import { saveCanonicalVideo } from "./services/canonical-content.js";

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";

function getFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), databaseURL: DATABASE_URL });
}

let installed = false;
if (!express.application.__indoTelegramMount) {
  express.application.__indoTelegramMount = true;
  const originalUse = express.application.use;
  const app = getFirebase();
  const db = app ? getDatabaseWithUrl(DATABASE_URL, app) : null;
  const auth = app ? admin.auth(app) : null;
  const baseRouter = createTelegramChunkRouter({
    express,
    db,
    auth,
    saveVideo: async ({ db: telegramDb, user, upload, streamUrl }) => {
      const profile = (await syncCanonicalUser({ db: telegramDb, uid: user.uid, includeContent: false })).profile;
      const videoRef = telegramDb.ref("videos").push();
      const video = {
        id: videoRef.key,
        mediaType: upload.mediaType || "video",
        ownerUid: user.uid,
        creator: profile.username || `@${user.uid.slice(0, 8)}`,
        creatorName: profile.name || "Indo User",
        title: upload.title || (upload.mediaType === "reel" ? "Untitled reel" : "Untitled video"),
        caption: upload.caption || "",
        secureUrl: streamUrl,
        videoUrl: streamUrl,
        duration: Number(upload.duration || 0),
        width: Number(upload.width || 0),
        height: Number(upload.height || 0),
        privacy: upload.privacy || "public",
        allowComments: upload.allowComments !== false,
        allowDuet: upload.allowDuet !== false,
        category: upload.category || "",
        tags: Array.isArray(upload.tags) ? upload.tags : [],
        location: upload.location || "",
        telegram: { provider: "telegram", uploadId: upload.uploadId, chunkSize: Number(upload.chunkSize || 0), totalChunks: Number(upload.totalChunks || 0), size: Number(upload.size || 0) },
        views: 0,
        likes: 0,
        createdAt: admin.database.ServerValue.TIMESTAMP,
        storage: { provider: "telegram" },
      };
      await videoRef.set(video);
      await saveCanonicalVideo({ db: telegramDb, uid: user.uid, video: { ...video, createdAt: Date.now() } });
      await telegramDb.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => (Number(current) || 0) + 1);
      await telegramDb.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => (Number(current) || 0) + 1);
      return video;
    },
  });
  const parsedRouter = express.Router();
  parsedRouter.use(express.json({ limit: "2mb", strict: true }));
  parsedRouter.use(baseRouter);

  express.application.use = function indoTelegramUse(...args) {
    originalUse.call(this, async (req, res, next) => {
      if (req.path.startsWith("/api/telegram/") || req.path.startsWith("/api/media/videos/telegram/")) {
        const origin = String(req.headers.origin || "").replace(/\/$/, "");
        if (origin === "https://yashwanthputtarajegowda.github.io") {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
          res.setHeader("Vary", "Origin");
        }
        if (req.method === "OPTIONS") return res.sendStatus(204);
        return parsedRouter(req, res, next);
      }
      return next();
    });
    return originalUse.apply(this, args);
  };
  installed = true;
}

export { installed };
