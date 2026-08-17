import express from "express";
import admin from "firebase-admin";
import { canonicalUserRoot, syncCanonicalUser } from "../services/user-canonical.js";
import { saveCanonicalVideo } from "../services/canonical-content.js";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function bool(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() !== "false";
}

function safeFileName(value, fallback = "indo-video.mp4") {
  const cleaned = text(value, 140)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || fallback;
}

function telegramConfig() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  return { token, chatId, configured: Boolean(token && chatId) };
}

async function sendTelegramVideo({ token, chatId, buffer, fileName, mimeType, caption }) {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", String(caption || "").slice(0, 1024));
  form.set("video", new Blob([buffer], { type: mimeType || "video/mp4" }), fileName);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: "POST",
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.description || "Telegram video upload failed.");
    error.status = response.status;
    throw error;
  }
  const video = data.result?.video;
  if (!video?.file_id) throw new Error("Telegram did not return a video file id.");
  return {
    messageId: Number(data.result?.message_id || 0),
    fileId: String(video.file_id),
    fileUniqueId: String(video.file_unique_id || ""),
    fileName,
  };
}

export function createTelegramMediaUploadRouter({ db, requireUser }) {
  const router = express.Router();

  router.use((req, _res, next) => {
    req.indoTelegramDb = db;
    req.indoTelegramRequireUser = requireUser;
    next();
  });

  router.post(
    "/telegram/uploads",
    express.raw({ type: () => true, limit: "50mb" }),
    async (req, res) => {
      const user = await req.indoTelegramRequireUser?.(req, res);
      if (!user) return;

      const database = req.indoTelegramDb;
      if (!database) return res.status(503).json({ ok: false, error: "Service unavailable." });

      const config = telegramConfig();
      if (!config.configured) {
        return res.status(503).json({ ok: false, error: "Telegram storage is not configured." });
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const incomingMime = String(req.headers["content-type"] || "video/mp4").split(";")[0].trim().toLowerCase();
      const mimeType = incomingMime === "application/octet-stream" ? "video/mp4" : incomingMime;
      if (!mimeType.startsWith("video/")) {
        return res.status(400).json({ ok: false, error: "Only video uploads are supported." });
      }
      if (!body.length) return res.status(400).json({ ok: false, error: "Video file is missing." });
      if (body.length > MAX_VIDEO_BYTES) return res.status(413).json({ ok: false, error: "Video must be 50 MB or smaller." });

      const mediaType = String(req.query.mediaType || req.headers["x-media-type"] || "video").toLowerCase() === "reel" ? "reel" : "video";
      const title = text(req.query.title || req.headers["x-title"], 120) || (mediaType === "reel" ? "Untitled reel" : "Untitled video");
      const caption = text(req.query.caption || req.headers["x-caption"], 500);
      const privacyRaw = text(req.query.privacy || req.headers["x-privacy"] || "public", 20);
      const privacy = ["public", "followers", "private"].includes(privacyRaw) ? privacyRaw : "public";
      const allowComments = bool(req.query.allowComments ?? req.headers["x-allow-comments"], true);
      const allowDuet = bool(req.query.allowDuet ?? req.headers["x-allow-duet"], true);
      const category = text(req.query.category || req.headers["x-category"], 60);
      const location = text(req.query.location || req.headers["x-location"], 120);
      const tags = String(req.query.tags || req.headers["x-tags"] || "").split(",").map((v) => v.trim().replace(/^#/, "")).filter(Boolean).slice(0, 20);
      const duration = Math.max(0, Number(req.query.duration ?? req.headers["x-duration"]) || 0);
      const width = Math.max(0, Number(req.query.width ?? req.headers["x-width"]) || 0);
      const height = Math.max(0, Number(req.query.height ?? req.headers["x-height"]) || 0);
      const uploadId = text(req.headers["x-upload-id"], 120);
      const fileName = safeFileName(req.query.fileName || req.headers["x-file-name"]);

      try {
        const profile = (await syncCanonicalUser({ db: database, uid: user.uid, includeContent: false })).profile;
        const telegram = await sendTelegramVideo({
          token: config.token,
          chatId: config.chatId,
          buffer: body,
          fileName,
          mimeType,
          caption: caption || title,
        });

        const videoRef = database.ref("videos").push();
        const video = {
          id: videoRef.key,
          mediaType,
          mimeType,
          ownerUid: user.uid,
          creator: profile.username || `@${String(user.uid).slice(0, 8)}`,
          creatorName: profile.name || "Indo User",
          title,
          caption,
          privacy,
          allowComments,
          allowDuet,
          category,
          tags,
          location,
          duration,
          width,
          height,
          views: 0,
          likes: 0,
          createdAt: admin.database.ServerValue.TIMESTAMP,
          storage: { provider: "telegram", mode: "direct-upload" },
          telegram: {
            provider: "telegram",
            uploadId,
            messageId: telegram.messageId,
            fileId: telegram.fileId,
            fileUniqueId: telegram.fileUniqueId,
            fileName: telegram.fileName,
            chatId: config.chatId,
          },
        };

        await videoRef.set(video);
        await saveCanonicalVideo({ db: database, uid: user.uid, video: { ...video, createdAt: Date.now() } });
        await database.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => (Number(current) || 0) + 1);
        await database.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => (Number(current) || 0) + 1);

        return res.status(201).json({ ok: true, uploadId, video });
      } catch (error) {
        console.error("Telegram upload failed:", error?.message || error);
        return res.status(Number(error?.status) === 429 ? 503 : 502).json({ ok: false, error: error?.message || "Could not upload video to Telegram." });
      }
    },
  );

  return router;
}
