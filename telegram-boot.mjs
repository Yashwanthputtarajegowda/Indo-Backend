import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { createTelegramChunkRouter, getTelegramChunkConfig } from "./services/telegram-chunk-storage.js";
import { canonicalUserRoot, syncCanonicalUser } from "./services/user-canonical.js";
import { saveCanonicalVideo } from "./services/canonical-content.js";

function env(name) {
  return String(process.env[name] || "").trim();
}

function getTelegramBotByKey(key) {
  const raw = String(key || "").trim();
  const match = raw.match(/^bot-(\d+)$/);
  const index = match ? Number(match[1]) : 1;
  const token = env(`TELEGRAM_BOT_TOKEN_${index}`) || (index === 1 ? env("TELEGRAM_BOT_TOKEN") : "");
  const chatId = env(`TELEGRAM_CHAT_ID_${index}`) || env("TELEGRAM_CHAT_ID");
  return token && chatId ? { key: `bot-${index}`, index, token, chatId } : null;
}

async function telegramFileBuffer(bot, fileId) {
  const form = new FormData();
  form.set("file_id", String(fileId));
  const metaResponse = await fetch(`https://api.telegram.org/bot${bot.token}/getFile`, {
    method: "POST",
    body: form,
  });
  const meta = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok || !meta?.ok || !meta?.result?.file_path) {
    throw new Error(meta?.description || "Telegram file metadata request failed.");
  }

  const fileResponse = await fetch(`https://api.telegram.org/file/bot${bot.token}/${meta.result.file_path}`);
  if (!fileResponse.ok) throw new Error(`Telegram file download failed (${fileResponse.status}).`);
  return Buffer.from(await fileResponse.arrayBuffer());
}

async function findTelegramVideo(db, uploadId) {
  const snapshot = await db.ref("videos").orderByChild("telegram/uploadId").equalTo(uploadId).limitToFirst(1).get();
  if (!snapshot.exists()) return null;
  const value = snapshot.val() || {};
  const [id, video] = Object.entries(value)[0] || [];
  return id && video ? { id, video } : null;
}

async function findTelegramUpload(db, ownerUid, uploadId) {
  const snapshot = await db.ref(`telegramUploads/${ownerUid}/${uploadId}`).get();
  return snapshot.exists() ? snapshot.val() : null;
}

async function streamTelegramVideo(req, res, db, uploadId) {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });

  const match = await findTelegramVideo(db, uploadId);
  if (!match) return res.status(404).json({ ok: false, error: "Telegram video not found." });

  const video = match.video || {};
  const ownerUid = String(video.ownerUid || "").trim();
  const upload = await findTelegramUpload(db, ownerUid, uploadId);
  if (!upload) return res.status(404).json({ ok: false, error: "Telegram upload metadata not found." });

  const totalSize = Number(upload.size || video.telegram?.size || 0);
  const totalChunks = Number(upload.totalChunks || video.telegram?.totalChunks || 0);
  const chunkSize = Number(upload.chunkSize || video.telegram?.chunkSize || 2 * 1024 * 1024);
  const chunks = upload.chunks || {};
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || !Number.isInteger(totalChunks) || totalChunks <= 0) {
    return res.status(500).json({ ok: false, error: "Invalid Telegram video metadata." });
  }

  let start = 0;
  let end = totalSize - 1;
  const range = String(req.headers.range || "").trim();

  if (range) {
    const parsed = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (!parsed) return res.status(416).set("Content-Range", `bytes */${totalSize}`).end();
    if (parsed[1]) start = Number(parsed[1]);
    if (parsed[2]) end = Number(parsed[2]);
    else end = totalSize - 1;
    if (!parsed[1] && parsed[2]) {
      const suffix = Number(parsed[2]);
      if (!Number.isFinite(suffix) || suffix <= 0) return res.status(416).set("Content-Range", `bytes */${totalSize}`).end();
      start = Math.max(0, totalSize - suffix);
      end = totalSize - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || end < start) {
      return res.status(416).set("Content-Range", `bytes */${totalSize}`).end();
    }
    end = Math.min(end, totalSize - 1);
  }

  const contentLength = end - start + 1;
  const mimeType = String(upload.mimeType || video.mimeType || "video/mp4").trim() || "video/mp4";
  res.set({
    "Accept-Ranges": "bytes",
    "Content-Type": mimeType,
    "Content-Length": String(contentLength),
    "Content-Disposition": "inline",
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });

  if (range) {
    res.status(206).set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
  } else {
    res.status(200);
  }

  if (req.method === "HEAD") return res.end();

  try {
    const firstChunk = Math.floor(start / chunkSize);
    const lastChunk = Math.floor(end / chunkSize);

    for (let index = firstChunk; index <= lastChunk; index += 1) {
      const chunk = chunks[index] || chunks[String(index)];
      if (!chunk?.fileId || !chunk?.botKey) throw new Error(`Telegram chunk ${index} is missing.`);
      const bot = getTelegramBotByKey(chunk.botKey);
      if (!bot) throw new Error(`Telegram bot for chunk ${index} is not configured.`);

      const data = await telegramFileBuffer(bot, chunk.fileId);
      const chunkStart = index * chunkSize;
      const from = Math.max(0, start - chunkStart);
      const to = Math.min(data.length, end - chunkStart + 1);
      if (to <= from) continue;

      if (!res.write(data.subarray(from, to))) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }

    return res.end();
  } catch (error) {
    if (!res.headersSent) return res.status(502).json({ ok: false, error: error?.message || "Telegram video stream failed." });
    return res.destroy(error);
  }
}

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
            mimeType: String(upload.mimeType || "video/mp4"),
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
      app.get("/api/media/videos/telegram/:uploadId/stream", (req, res) => streamTelegramVideo(req, res, db, String(req.params.uploadId || "").trim()));
      app.get("/api/telegram/storage-health", (_req, res) => {
        res.json({ ok: true, ...getTelegramChunkConfig() });
      });
      app.__indoTelegramRoutesAttached = true;
      console.log("Telegram chunk storage enabled.", getTelegramChunkConfig());
    }
    return originalListen.apply(this, args);
  };
}