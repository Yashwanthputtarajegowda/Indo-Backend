import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { createTelegramChunkRouter, getTelegramChunkConfig } from "./services/telegram-chunk-storage.js";
import { canonicalUserRoot, syncCanonicalUser } from "./services/user-canonical.js";
import { saveCanonicalVideo } from "./services/canonical-content.js";

if (admin.apps.length === 0) {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || "indo-174f0").trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const databaseURL = String(process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com").trim();
  if (clientEmail && privateKey) {
    admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), databaseURL });
  }
}

const originalListen = express.application.listen;
if (!express.application.__indoTelegramPatched) {
  express.application.__indoTelegramPatched = true;
  express.application.listen = function indoTelegramListen(...args) {
    if (!this.__indoTelegramRoutesAttached) {
      const app = this;
      const firebaseApp = admin.apps.length ? admin.app() : null;
      const db = firebaseApp ? getDatabaseWithUrl(String(process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com").trim(), firebaseApp) : null;
      const auth = firebaseApp ? admin.auth(firebaseApp) : null;
      const router = createTelegramChunkRouter({
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
      app.use(router);
      app.get("/api/telegram/storage-health", (_req, res) => {
        res.json({ ok: true, ...getTelegramChunkConfig() });
      });
      app.__indoTelegramRoutesAttached = true;
      console.log("Telegram chunk storage enabled.", getTelegramChunkConfig());
    }
    return originalListen.apply(this, args);
  };
}
