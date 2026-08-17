import express from "express";
import admin from "firebase-admin";
import { mirrorVideoBuffer, telegramStorageConfigured } from "../services/telegram-storage.js";
import { canonicalUserRoot, syncCanonicalUser } from "../services/user-canonical.js";
import { saveCanonicalVideo } from "../services/canonical-content.js";

function safeText(value, max) {
  return String(value || "").trim().slice(0, max);
}

function parseBool(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim().toLowerCase() !== "false";
}

function safeUploadFileName(value, fallback) {
  const raw = safeText(value, 140);
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || fallback;
}

export function createTelegramMediaUploadRouter({ db, requireUser }) {
  const router = express.Router();

  router.post(
    "/media/videos/upload-telegram",
    express.raw({ type: (req) => /^video\/.+$/i.test(String(req.headers["content-type"] || "")) || String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() === "application/octet-stream", limit: "50mb" }),
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
      if (!telegramStorageConfigured()) {
        return res.status(503).json({ ok: false, error: "Telegram storage is not configured." });
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!body.length) {
        return res.status(400).json({ ok: false, error: "Video file is missing." });
      }
      if (body.length > 50 * 1024 * 1024) {
        return res.status(413).json({ ok: false, error: "This upload is larger than the current Telegram Bot API limit." });
      }

      const mediaType = String(req.query.mediaType || req.headers["x-media-type"] || "video").trim().toLowerCase() === "reel" ? "reel" : "video";
      const title = safeText(req.query.title || req.headers["x-title"], 120) || (mediaType === "reel" ? "Untitled reel" : "Untitled video");
      const caption = safeText(req.query.caption || req.headers["x-caption"], 500);
      const privacy = ["public", "followers", "private"].includes(String(req.query.privacy || req.headers["x-privacy"] || "public"))
        ? String(req.query.privacy || req.headers["x-privacy"] || "public")
        : "public";
      const allowComments = parseBool(req.query.allowComments ?? req.headers["x-allow-comments"], true);
      const allowDuet = parseBool(req.query.allowDuet ?? req.headers["x-allow-duet"], true);
      const category = safeText(req.query.category || req.headers["x-category"], 60);
      const location = safeText(req.query.location || req.headers["x-location"], 120);
      const tags = String(req.query.tags || req.headers["x-tags"] || "")
        .split(",")
        .map((tag) => tag.trim().replace(/^#/, ""))
        .filter(Boolean)
        .slice(0, 20);
      const duration = Math.max(0, Number(req.query.duration ?? req.headers["x-duration"]) || 0);
      const width = Math.max(0, Number(req.query.width ?? req.headers["x-width"]) || 0);
      const height = Math.max(0, Number(req.query.height ?? req.headers["x-height"]) || 0);
      const fallbackExtension = String(req.headers["content-type"] || "").split("/")[1]?.split(";")[0] || "mp4";
      const fileName = safeUploadFileName(req.query.fileName || req.headers["x-file-name"], `${mediaType}-${Date.now()}.${fallbackExtension}`);

      try {
        const profile = (await syncCanonicalUser({ db, uid: user.uid, includeContent: false })).profile;
        const telegram = await mirrorVideoBuffer({
          buffer: body,
          caption: caption || title,
          fileName,
        });

        const videoRef = db.ref("videos").push();
        const video = {
          id: videoRef.key,
          mediaType,
          ownerUid: user.uid,
          creator: profile.username || `@${user.uid.slice(0, 8)}`,
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
          storage: { provider: "telegram", source: "direct-upload" },
          telegram: {
            provider: "telegram",
            messageId: telegram.messageId,
            fileId: telegram.fileId,
            fileUniqueId: telegram.fileUniqueId,
            fileName: telegram.fileName,
            chatId: String(process.env.TELEGRAM_CHAT_ID || "").trim(),
          },
        };

        await videoRef.set(video);
        await saveCanonicalVideo({ db, uid: user.uid, video: { ...video, createdAt: Date.now() } });
        await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => (Number(current) || 0) + 1);
        await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => (Number(current) || 0) + 1);

        return res.status(201).json({ ok: true, video });
      } catch (error) {
        console.error("Direct Telegram video upload failed:", error?.message || error);
        return res.status(502).json({ ok: false, error: error?.message || "Could not upload video to Telegram." });
      }
    },
  );

  return router;
}
