import "dotenv/config";
import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { Readable } from "node:stream";
import {
  mirrorPhotoFromUrl,
  mirrorVideoFromUrl,
  mirrorVideoBuffer,
  telegramStorageConfigured,
  getTelegramFileUrl,
} from "./services/telegram-storage.js";
import { canonicalUserRoot, syncCanonicalUser } from "./services/user-canonical.js";
import { saveCanonicalVideo } from "./services/canonical-content.js";

const enabled =
  String(process.env.TELEGRAM_MIRROR_ENABLED || "true")
    .trim()
    .toLowerCase() !== "false";

if (!enabled || !telegramStorageConfigured()) {
  // Telegram features stay disabled until the secrets are configured.
} else {
  const DATABASE_URL =
    process.env.FIREBASE_DATABASE_URL ||
    "https://indo-174f0-default-rtdb.firebaseio.com";

  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        databaseURL: DATABASE_URL,
      });
    }
  }

  const db = admin.apps.length
    ? getDatabaseWithUrl(DATABASE_URL, admin.app())
    : null;
  const auth = admin.apps.length ? admin.auth(admin.app()) : null;

  async function verifyUser(req, res) {
    if (!auth) {
      res.status(503).json({ ok: false, error: "Authentication service is unavailable." });
      return null;
    }
    const header = String(req.headers.authorization || "");
    if (!/^Bearer\s+\S+$/i.test(header)) {
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

  const originalUse = express.application.use;
  express.application.use = function telegramUse(...args) {
    if (!this.__indoTelegramFeaturesInstalled) {
      this.__indoTelegramFeaturesInstalled = true;

      // Stream an existing Telegram-backed video through the backend.
      originalUse.call(this, async (req, res, next) => {
        const match = String(req.path || "").match(/^\/api\/media\/videos\/([^/]+)\/stream$/);
        if (!match || !db) return next();

        const videoId = decodeURIComponent(match[1]);
        try {
          const snapshot = await db.ref(`videos/${videoId}`).get();
          if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Video not found." });

          const video = snapshot.val() || {};
          const telegram = video.telegram || video.telegramStorage || {};
          const fileId = String(telegram.fileId || "").trim();
          if (!fileId) return next();

          const fileUrl = await getTelegramFileUrl(fileId);
          const headers = {};
          const range = String(req.headers.range || "").trim();
          if (range) headers.Range = range;

          const upstream = await fetch(fileUrl, { headers });
          if (!upstream.ok || !upstream.body) {
            return res.status(upstream.status || 502).json({ ok: false, error: "Telegram media could not be streamed." });
          }

          res.status(upstream.status === 206 ? 206 : 200);
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Cache-Control", "private, max-age=30");
          res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
          for (const headerName of ["content-length", "content-range", "content-disposition"]) {
            const value = upstream.headers.get(headerName);
            if (value) res.setHeader(headerName, value);
          }
          Readable.fromWeb(upstream.body).pipe(res);
        } catch (error) {
          console.warn("Telegram video stream failed:", error?.message || error);
          if (!res.headersSent) return res.status(502).json({ ok: false, error: "Telegram media could not be streamed." });
          res.destroy(error);
        }
      });

      // Accept direct app uploads as raw video bytes and store them in Telegram.
      this.post(
        "/api/media/videos/upload-telegram",
        express.raw({ type: /^video\/.+$/i, limit: "50mb" }),
        async (req, res) => {
          const user = await verifyUser(req, res);
          if (!user) return;
          if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });

          const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
          if (!body.length) return res.status(400).json({ ok: false, error: "Video file is missing." });
          if (body.length > 50 * 1024 * 1024) {
            return res.status(413).json({ ok: false, error: "This video is larger than the current Telegram upload limit of 50 MB." });
          }

          const mediaType = String(req.query.mediaType || "video").trim().toLowerCase() === "reel" ? "reel" : "video";
          const title = String(req.query.title || "").trim().slice(0, 120) || (mediaType === "reel" ? "Untitled reel" : "Untitled video");
          const caption = String(req.query.caption || "").trim().slice(0, 500);
          const privacyValue = String(req.query.privacy || "public").trim().toLowerCase();
          const privacy = ["public", "followers", "private"].includes(privacyValue) ? privacyValue : "public";
          const allowComments = String(req.query.allowComments ?? "true").trim().toLowerCase() !== "false";
          const allowDuet = String(req.query.allowDuet ?? "true").trim().toLowerCase() !== "false";
          const category = String(req.query.category || "").trim().slice(0, 60);
          const location = String(req.query.location || "").trim().slice(0, 120);
          const tags = String(req.query.tags || "").split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean).slice(0, 20);
          const duration = Math.max(0, Number(req.query.duration) || 0);
          const width = Math.max(0, Number(req.query.width) || 0);
          const height = Math.max(0, Number(req.query.height) || 0);
          const fileName = String(req.headers["x-file-name"] || "").trim().slice(0, 140) || `${mediaType}-${Date.now()}.mp4`;

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
            console.error("Direct Telegram upload failed:", error?.message || error);
            return res.status(502).json({ ok: false, error: error?.message || "Could not upload video to Telegram." });
          }
        },
      );
    }

    return originalUse.apply(this, args);
  };

  const response = express.response;
  const originalJson = response.json;

  response.json = async function telegramAwareJson(payload) {
    try {
      const requestPath = String(this.req?.path || "");

      if (db && payload?.ok && requestPath === "/api/media/videos" && Array.isArray(payload.videos)) {
        const host = this.req?.get?.("host") || "";
        const proto = this.req?.protocol || "https";
        const baseUrl = host ? `${proto}://${host}` : "";
        payload.videos = payload.videos.map((video) => {
          if (!video || typeof video !== "object") return video;
          const telegram = video.telegram || video.telegramStorage;
          if (!telegram?.fileId || !video.id || !baseUrl) return video;
          const streamUrl = `${baseUrl}/api/media/videos/${encodeURIComponent(video.id)}/stream`;
          return { ...video, secureUrl: streamUrl, videoUrl: streamUrl, telegramPlayback: streamUrl };
        });
      }

      if (db && payload?.ok && requestPath === "/api/media/videos" && payload.video?.id && payload.video?.secureUrl) {
        try {
          const mirror = await mirrorVideoFromUrl({
            mediaUrl: payload.video.secureUrl,
            caption: payload.video.caption || payload.video.title || "Indo media",
            fileName: payload.video.title || payload.video.id,
          });
          await db.ref(`videos/${payload.video.id}`).update({ telegramStorage: mirror, storageMirrorUpdatedAt: Date.now() });
          payload.video = { ...payload.video, telegramStorage: mirror };
        } catch (error) {
          console.warn("Telegram video mirror skipped:", error?.message || error);
        }
      }

      if (db && payload?.ok && requestPath === "/api/stories" && payload.story?.id && payload.story?.secureUrl) {
        try {
          const mirror = await mirrorPhotoFromUrl({
            mediaUrl: payload.story.secureUrl,
            caption: payload.story.name || payload.story.username || "Indo story",
          });
          await db.ref(`stories/${payload.story.id}`).update({ telegramStorage: mirror, storageMirrorUpdatedAt: Date.now() });
          payload.story = { ...payload.story, telegramStorage: mirror };
        } catch (error) {
          console.warn("Telegram story mirror skipped:", error?.message || error);
        }
      }
    } catch (error) {
      console.warn("Telegram storage mirror hook failed:", error?.message || error);
    }

    return originalJson.call(this, payload);
  };
}
