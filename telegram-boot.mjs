import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { canonicalUserRoot, syncCanonicalUser } from "./services/user-canonical.js";
import { saveCanonicalVideo } from "./services/canonical-content.js";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_BOTS = 50;

function env(name) {
  return String(process.env[name] || "").trim();
}

function bots() {
  const out = [];
  for (let index = 1; index <= MAX_BOTS; index += 1) {
    const token = env(`TELEGRAM_BOT_TOKEN_${index}`) || (index === 1 ? env("TELEGRAM_BOT_TOKEN") : "");
    const chatId = env(`TELEGRAM_CHAT_ID_${index}`) || env("TELEGRAM_CHAT_ID");
    if (token && chatId) out.push({ key: `bot-${index}`, index, token, chatId });
  }
  return out;
}

function safeId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9_-]{8,120}$/.test(id) ? id : "";
}

function safeFileName(value) {
  return String(value || "indo-video.mp4").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "indo-video.mp4";
}

function safeMime(value) {
  const mime = String(value || "video/mp4").trim().slice(0, 120);
  return mime.startsWith("video/") ? mime : "video/mp4";
}

async function telegramCall(bot, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${bot.token}/${method}`, { method: "POST", body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.description || `Telegram ${method} failed.`);
    error.telegramResponse = data;
    error.status = response.status;
    throw error;
  }
  return data.result;
}

async function telegramFileBuffer(bot, fileId) {
  const form = new FormData();
  form.set("file_id", String(fileId));
  const file = await telegramCall(bot, "getFile", form);
  const filePath = String(file?.file_path || "").trim();
  if (!filePath) throw new Error("Telegram file path is missing.");
  const response = await fetch(`https://api.telegram.org/file/bot${bot.token}/${filePath}`);
  if (!response.ok) throw new Error(`Telegram file download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function authUser(auth, req, res) {
  const header = String(req.headers.authorization || "");
  if (!auth || !/^Bearer\s+\S+$/i.test(header)) {
    res.status(401).json({ ok: false, error: "Authentication required." });
    return null;
  }
  try {
    return await auth.verifyIdToken(header.replace(/^Bearer\s+/i, "").trim(), true);
  } catch {
    res.status(401).json({ ok: false, error: "Invalid or expired authentication token." });
    return null;
  }
}

function disableLegacyMediaRoutes(app) {
  const stack = app.router?.stack;
  if (!Array.isArray(stack)) return;
  for (const layer of stack) {
    const path = String(layer?.route?.path || "");
    if (path === "/api/media/signature") layer.route.stack = [];
  }
}

async function saveSingleVideo({ db, user, upload, streamUrl }) {
  const profile = (await syncCanonicalUser({ db, uid: user.uid, includeContent: false })).profile;
  const videoRef = db.ref("videos").push();
  const video = {
    id: videoRef.key,
    mediaType: upload.mediaType || "video",
    mimeType: upload.mimeType,
    ownerUid: user.uid,
    creator: profile.username || `@${user.uid.slice(0, 8)}`,
    creatorName: profile.name || "Indo User",
    title: upload.title,
    caption: upload.caption,
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
    telegram: {
      provider: "telegram",
      uploadId: upload.uploadId,
      botKey: upload.botKey,
      fileId: upload.fileId,
      fileUniqueId: upload.fileUniqueId || "",
      messageId: Number(upload.messageId || 0),
      size: Number(upload.size || 0),
      mimeType: upload.mimeType,
      singleFile: true,
    },
    storage: { provider: "telegram", mode: "single-file" },
    views: 0,
    likes: 0,
    createdAt: admin.database.ServerValue.TIMESTAMP,
  };
  await videoRef.set(video);
  await saveCanonicalVideo({ db, uid: user.uid, video: { ...video, createdAt: Date.now() } });
  await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => (Number(current) || 0) + 1);
  await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => (Number(current) || 0) + 1);
  return video;
}

if (admin.apps.length === 0) {
  const projectId = env("FIREBASE_PROJECT_ID") || "indo-174f0";
  const clientEmail = env("FIREBASE_CLIENT_EMAIL");
  const privateKey = env("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");
  const databaseURL = env("FIREBASE_DATABASE_URL") || "https://indo-174f0-default-rtdb.firebaseio.com";
  if (clientEmail && privateKey) admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), databaseURL });
}

const originalListen = express.application.listen;
if (!express.application.__indoTelegramSingleVideoPatched) {
  express.application.__indoTelegramSingleVideoPatched = true;
  express.application.listen = function indoTelegramSingleVideoListen(...args) {
    if (!this.__indoTelegramSingleVideoAttached) {
      const app = this;
      const firebaseApp = admin.apps.length ? admin.app() : null;
      const db = firebaseApp ? getDatabaseWithUrl(env("FIREBASE_DATABASE_URL") || "https://indo-174f0-default-rtdb.firebaseio.com", firebaseApp) : null;
      const auth = firebaseApp ? admin.auth(firebaseApp) : null;
      disableLegacyMediaRoutes(app);

      app.post("/api/telegram/uploads", express.raw({ type: "application/octet-stream", limit: "50mb" }), async (req, res) => {
        const user = await authUser(auth, req, res);
        if (!user || !db) return;
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const clientUploadId = safeId(req.headers["x-upload-id"]);
        const fileName = safeFileName(req.headers["x-file-name"]);
        const mimeType = safeMime(req.headers["x-mime-type"]);
        const size = Number(req.headers["x-file-size"] || body.length);
        const mediaType = String(req.headers["x-media-type"] || "video").toLowerCase() === "reel" ? "reel" : "video";
        const title = String(req.headers["x-title"] || fileName).trim().slice(0, 120) || fileName;
        const caption = String(req.headers["x-caption"] || "").trim().slice(0, 500);
        const privacyRaw = String(req.headers["x-privacy"] || "public");
        const privacy = ["public", "followers", "private"].includes(privacyRaw) ? privacyRaw : "public";
        const allowComments = String(req.headers["x-allow-comments"] ?? "true") !== "false";
        const allowDuet = String(req.headers["x-allow-duet"] ?? "true") !== "false";
        const category = String(req.headers["x-category"] || "").trim().slice(0, 60);
        const tags = String(req.headers["x-tags"] || "").split(",").map((v) => v.trim()).filter(Boolean).slice(0, 20);
        const location = String(req.headers["x-location"] || "").trim().slice(0, 120);
        const duration = Number(req.headers["x-duration"] || 0);
        const width = Number(req.headers["x-width"] || 0);
        const height = Number(req.headers["x-height"] || 0);

        if (!body.length || !Number.isSafeInteger(size) || size !== body.length || size > MAX_VIDEO_BYTES) {
          return res.status(413).json({ ok: false, error: "Video must be a single file no larger than 50 MB." });
        }
        if (!clientUploadId) return res.status(400).json({ ok: false, error: "Upload ID is required." });
        if (!mimeType.startsWith("video/")) return res.status(400).json({ ok: false, error: "Only video files are allowed." });

        const idempotencyRef = db.ref(`telegramSingleUploads/${user.uid}/${clientUploadId}`);
        const existingSnapshot = await idempotencyRef.get();
        if (existingSnapshot.exists()) {
          const existing = existingSnapshot.val() || {};
          if (existing.videoId) {
            const videoSnapshot = await db.ref(`videos/${existing.videoId}`).get();
            if (videoSnapshot.exists()) return res.json({ ok: true, duplicate: true, video: videoSnapshot.val() });
          }
        }

        const pool = bots();
        if (!pool.length) return res.status(503).json({ ok: false, error: "Telegram storage is not configured." });
        const bot = pool[0];
        const uploadId = db.ref(`telegramSingleUploads/${user.uid}`).push().key;
        const streamUrl = `${req.protocol || "https"}://${req.get("host")}/api/media/videos/telegram/${encodeURIComponent(uploadId)}/stream`;

        try {
          const form = new FormData();
          form.set("chat_id", bot.chatId);
          form.set("caption", `INDO_VIDEO ${uploadId}`);
          form.set("document", new Blob([body], { type: mimeType }), fileName);
          const message = await telegramCall(bot, "sendDocument", form);
          const document = message?.document;
          if (!document?.file_id) throw new Error("Telegram did not return a file_id.");

          const upload = {
            uploadId,
            ownerUid: user.uid,
            clientUploadId,
            fileName,
            mimeType,
            mediaType,
            title,
            caption,
            privacy,
            allowComments,
            allowDuet,
            category,
            tags,
            location,
            duration: Number.isFinite(duration) ? duration : 0,
            width: Number.isFinite(width) ? width : 0,
            height: Number.isFinite(height) ? height : 0,
            size,
            botKey: bot.key,
            botIndex: bot.index,
            fileId: String(document.file_id),
            fileUniqueId: String(document.file_unique_id || ""),
            messageId: Number(message.message_id || 0),
            status: "uploaded",
            singleFile: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const video = await saveSingleVideo({ db, user, upload, streamUrl });
          await idempotencyRef.set({ uploadId, videoId: video.id, createdAt: Date.now(), updatedAt: Date.now() });
          return res.status(201).json({ ok: true, uploadId, video });
        } catch (error) {
          return res.status(Number(error?.status) === 429 ? 503 : 502).json({ ok: false, error: error?.message || "Telegram upload failed." });
        }
      });

      app.get("/api/media/videos/telegram/:uploadId/stream", async (req, res) => {
        if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
        const uploadId = safeId(req.params.uploadId);
        if (!uploadId) return res.status(400).json({ ok: false, error: "Invalid upload ID." });
        const snapshot = await db.ref("telegramSingleUploads").get();
        let upload = null;
        Object.values(snapshot.val() || {}).some((userUploads) => {
          if (userUploads?.[uploadId]) {
            upload = userUploads[uploadId];
            return true;
          }
          return false;
        });
        if (!upload?.fileId || !upload?.botKey) return res.status(404).json({ ok: false, error: "Telegram video file not found." });
        const bot = bots().find((item) => item.key === upload.botKey);
        if (!bot) return res.status(404).json({ ok: false, error: "Telegram bot is not configured." });

        const totalSize = Number(upload.size || 0);
        if (!Number.isSafeInteger(totalSize) || totalSize <= 0) return res.status(500).json({ ok: false, error: "Invalid Telegram video metadata." });
        let start = 0;
        let end = totalSize - 1;
        const range = String(req.headers.range || "").trim();
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
          if (!match) return res.status(416).set("Content-Range", `bytes */${totalSize}`).end();
          if (match[1]) start = Number(match[1]);
          if (match[2]) end = Number(match[2]);
          else end = totalSize - 1;
          if (!match[1] && match[2]) start = Math.max(0, totalSize - Number(match[2]));
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || end < start) return res.status(416).set("Content-Range", `bytes */${totalSize}`).end();
          end = Math.min(end, totalSize - 1);
        }

        const contentLength = end - start + 1;
        res.set({
          "Accept-Ranges": "bytes",
          "Content-Type": safeMime(upload.mimeType),
          "Content-Length": String(contentLength),
          "Content-Disposition": "inline",
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        });
        if (range) res.status(206).set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
        else res.status(200);
        if (req.method === "HEAD") return res.end();

        try {
          const data = await telegramFileBuffer(bot, upload.fileId);
          if (data.length !== totalSize) throw new Error("Telegram file size does not match stored metadata.");
          return res.end(data.subarray(start, end + 1));
        } catch (error) {
          if (!res.headersSent) return res.status(502).json({ ok: false, error: error?.message || "Telegram video stream failed." });
          return res.destroy(error);
        }
      });

      app.get("/api/telegram/storage-health", (_req, res) => {
        res.json({ ok: true, configured: bots().length > 0, botCount: bots().length, mode: "single-file", maxVideoBytes: MAX_VIDEO_BYTES });
      });
      this.__indoTelegramSingleVideoAttached = true;
      console.log("Telegram single-file video storage enabled.");
    }
    return originalListen.apply(this, args);
  };
}
