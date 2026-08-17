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

async function telegramCall(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.description || `Telegram ${method} failed.`);
    error.status = response.status;
    throw error;
  }
  return data.result;
}

async function sendTelegramVideo({ token, chatId, buffer, fileName, mimeType, caption }) {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", String(caption || "").slice(0, 1024));
  form.set("video", new Blob([buffer], { type: mimeType || "video/mp4" }), fileName);

  const message = await telegramCall(token, "sendVideo", form);
  const video = message?.video;
  if (!video?.file_id) throw new Error("Telegram did not return a video file id.");
  return {
    messageId: Number(message.message_id || 0),
    fileId: String(video.file_id),
    fileUniqueId: String(video.file_unique_id || ""),
    fileName,
  };
}

async function fetchTelegramFileBuffer({ token, fileId }) {
  const form = new FormData();
  form.set("file_id", String(fileId));
  const file = await telegramCall(token, "getFile", form);
  const filePath = String(file?.file_path || "").trim();
  if (!filePath) throw new Error("Telegram file path is missing.");

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
    },
  });
  if (!response.ok) throw new Error(`Telegram file download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

function setStreamHeaders(res, { mimeType, total, start, end, partial }) {
  const length = end - start + 1;
  res.set({
    "Accept-Ranges": "bytes",
    "Content-Type": mimeType || "video/mp4",
    "Content-Length": String(length),
    "Content-Disposition": "inline",
    // Telegram is the only playback source. Never allow the browser, CDN or
    // intermediate proxy to reuse a previous video response.
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (partial) {
    res.status(206).set("Content-Range", `bytes ${start}-${end}/${total}`);
  } else {
    res.status(200);
  }
}

export function createTelegramMediaUploadRouter({ db, requireUser }) {
  const router = express.Router();

  router.use((req, _res, next) => {
    req.indoTelegramDb = db;
    req.indoTelegramRequireUser = requireUser;
    next();
  });

  const uploadHandler = async (req, res) => {
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
    const tags = String(req.query.tags || req.headers["x-tags"] || "")
      .split(",")
      .map((v) => v.trim().replace(/^#/, ""))
      .filter(Boolean)
      .slice(0, 20);
    const duration = Math.max(0, Number(req.query.duration ?? req.headers["x-duration"]) || 0);
    const width = Math.max(0, Number(req.query.width ?? req.headers["x-width"]) || 0);
    const height = Math.max(0, Number(req.query.height ?? req.headers["x-height"]) || 0);
    const uploadId = text(req.headers["x-upload-id"], 120) || `upload-${Date.now()}`;
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
      const videoId = String(videoRef.key);
      const baseUrl = `${req.protocol || "https"}://${req.get("host")}`;
      const streamUrl = `${baseUrl}/api/media/videos/${encodeURIComponent(videoId)}/telegram-stream`;

      const video = {
        id: videoId,
        mediaType,
        mimeType,
        ownerUid: user.uid,
        creator: profile.username || `@${String(user.uid).slice(0, 8)}`,
        creatorName: profile.name || "Indo User",
        title,
        caption,
        secureUrl: streamUrl,
        videoUrl: streamUrl,
        streamUrl,
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
          mimeType,
          size: body.length,
          streamUrl,
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
  };

  router.post(
    "/telegram/uploads",
    express.raw({ type: () => true, limit: "50mb" }),
    uploadHandler,
  );

  router.post(
    "/media/videos/upload-telegram",
    express.raw({ type: () => true, limit: "50mb" }),
    uploadHandler,
  );

  const streamHandler = async (req, res) => {
    const database = req.indoTelegramDb;
    if (!database) return res.status(503).json({ ok: false, error: "Service unavailable." });

    const videoId = text(req.params.videoId, 200);
    if (!videoId) return res.status(400).json({ ok: false, error: "Invalid video ID." });

    try {
      const snapshot = await database.ref(`videos/${videoId}`).get();
      if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Video not found." });

      const video = snapshot.val() || {};
      const provider = String(video.storage?.provider || video.telegram?.provider || "").toLowerCase();
      if (provider !== "telegram") return res.status(404).json({ ok: false, error: "Telegram video not found." });

      const fileId = String(video.telegram?.fileId || "").trim();
      const config = telegramConfig();
      if (!fileId || !config.configured) return res.status(404).json({ ok: false, error: "Telegram video file is unavailable." });

      const buffer = await fetchTelegramFileBuffer({ token: config.token, fileId });
      const total = buffer.length;
      if (!total) return res.status(404).json({ ok: false, error: "Telegram video file is empty." });

      if (req.method === "HEAD") {
        const mimeType = String(video.mimeType || video.telegram?.mimeType || "video/mp4");
        setStreamHeaders(res, { mimeType, total, start: 0, end: total - 1, partial: false });
        return res.end();
      }

      let start = 0;
      let end = total - 1;
      let partial = false;
      const range = String(req.headers.range || "").trim();

      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
        if (!match) return res.status(416).set("Content-Range", `bytes */${total}`).end();
        if (match[1]) start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
        else end = total - 1;
        if (!match[1] && match[2]) start = Math.max(0, total - Number(match[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) {
          return res.status(416).set("Content-Range", `bytes */${total}`).end();
        }
        end = Math.min(end, total - 1);
        partial = true;
      }

      const mimeType = String(video.mimeType || video.telegram?.mimeType || "video/mp4");
      setStreamHeaders(res, { mimeType, total, start, end, partial });
      return res.end(buffer.subarray(start, end + 1));
    } catch (error) {
      console.error("Telegram video stream failed:", error?.message || error);
      if (!res.headersSent) return res.status(502).json({ ok: false, error: error?.message || "Telegram video stream failed." });
      return res.destroy(error);
    }
  };

  router.get("/media/videos/:videoId/telegram-stream", streamHandler);
  router.head("/media/videos/:videoId/telegram-stream", streamHandler);

  router.get("/telegram/storage-health", (_req, res) => {
    const config = telegramConfig();
    res.set({
      "Cache-Control": "no-store, no-cache, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.json({
      ok: true,
      configured: config.configured,
      mode: "single-file",
      sourceOfTruth: "telegram-bot",
      cache: "disabled",
      maxVideoBytes: MAX_VIDEO_BYTES,
    });
  });

  return router;
}
