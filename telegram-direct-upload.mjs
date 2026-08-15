import Busboy from "busboy";
import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { mirrorVideoBuffer, telegramStorageConfigured } from "./services/telegram-storage.js";
import { canonicalUserRoot, syncCanonicalUser } from "./services/user-canonical.js";
import { saveCanonicalVideo } from "./services/canonical-content.js";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";

function getFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL: DATABASE_URL,
  });
}

async function requireUser(req, res) {
  const app = getFirebase();
  if (!app) {
    res.status(503).json({ ok: false, error: "Authentication service is unavailable." });
    return null;
  }
  const header = String(req.headers.authorization || "");
  if (!/^Bearer\\s+\\S+$/i.test(header)) {
    res.status(401).json({ ok: false, error: "Authentication required." });
    return null;
  }
  const token = header.replace(/^Bearer\\s+/i, "").trim();
  try {
    return await admin.auth(app).verifyIdToken(token, true);
  } catch {
    res.status(401).json({ ok: false, error: "Invalid or expired authentication token." });
    return null;
  }
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.startsWith("multipart/form-data")) {
      reject(new Error("Multipart upload is required."));
      return;
    }

    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 20 },
    });
    const fields = {};
    const chunks = [];
    let fileName = "indo-video.mp4";
    let fileMime = "video/mp4";
    let tooLarge = false;

    busboy.on("field", (name, value) => {
      fields[name] = String(value || "");
    });

    busboy.on("file", (_name, stream, info) => {
      fileName = String(info?.filename || fileName).slice(0, 180);
      fileMime = String(info?.mimeType || fileMime);
      if (!fileMime.startsWith("video/")) {
        stream.resume();
        reject(new Error("Please select a valid video file."));
        return;
      }
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => {
        tooLarge = true;
      });
    });

    busboy.on("error", reject);
    busboy.on("finish", () => {
      if (tooLarge) {
        reject(new Error("Video is larger than Telegram Bot API's 50 MB upload limit."));
        return;
      }
      resolve({ fields, buffer: Buffer.concat(chunks), fileName, fileMime });
    });

    req.pipe(busboy);
  });
}

const originalUse = express.application.use;
if (!express.application.__indoDirectTelegramUpload) {
  express.application.__indoDirectTelegramUpload = true;
  express.application.use = function indoDirectTelegramUse(...args) {
    originalUse.call(this, async (req, res, next) => {
      if (req.method !== "POST" || req.path !== "/api/media/videos/upload") return next();
      if (!telegramStorageConfigured()) {
        return res.status(503).json({ ok: false, error: "Telegram storage is temporarily unavailable." });
      }

      const user = await requireUser(req, res);
      if (!user) return;

      try {
        const { fields, buffer, fileName } = await parseMultipart(req);
        if (!buffer.length) {
          return res.status(400).json({ ok: false, error: "Select a video file first." });
        }

        const mediaType = String(fields.mediaType || "video").trim().toLowerCase() === "reel" ? "reel" : "video";
        const title = String(fields.title || "").trim().slice(0, 120);
        const caption = String(fields.caption || fields.description || "").trim().slice(0, 500);
        if (!title) return res.status(400).json({ ok: false, error: "Add a title first." });

        const duration = Number(fields.duration || 0);
        const width = Number(fields.width || 0);
        const height = Number(fields.height || 0);
        if (!Number.isFinite(duration) || duration < 0 || duration > 3600 || !Number.isFinite(width) || width < 0 || width > 20000 || !Number.isFinite(height) || height < 0 || height > 20000) {
          return res.status(400).json({ ok: false, error: "Invalid video metadata." });
        }

        const app = getFirebase();
        const db = app ? getDatabaseWithUrl(DATABASE_URL, app) : null;
        if (!db) return res.status(503).json({ ok: false, error: "Database service is unavailable." });

        const profile = (await syncCanonicalUser({ db, uid: user.uid, includeContent: false })).profile;
        const telegram = await mirrorVideoBuffer({ buffer, fileName, caption });
        const videoRef = db.ref("videos").push();
        const video = {
          id: videoRef.key,
          mediaType,
          ownerUid: user.uid,
          creator: profile.username || `@${user.uid.slice(0, 8)}`,
          creatorName: profile.name || "Indo User",
          title: title || (mediaType === "reel" ? "Untitled reel" : "Untitled video"),
          caption,
          duration,
          width,
          height,
          views: 0,
          likes: 0,
          createdAt: admin.database.ServerValue.TIMESTAMP,
          telegram: {
            provider: "telegram",
            chatId: String(process.env.TELEGRAM_CHAT_ID || "").trim(),
            messageId: telegram.messageId,
            fileId: telegram.fileId,
            fileUniqueId: telegram.fileUniqueId,
            fileName: telegram.fileName,
            uploadedAt: Date.now(),
          },
          storage: {
            provider: "telegram",
          },
        };

        await videoRef.set(video);
        await saveCanonicalVideo({ db, uid: user.uid, video: { ...video, createdAt: Date.now() } });
        await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => (Number(current) || 0) + 1);
        await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => (Number(current) || 0) + 1);

        const proto = req.protocol || "https";
        const host = req.get("host");
        const streamUrl = `${proto}://${host}/api/media/videos/${encodeURIComponent(video.id)}/stream`;
        return res.status(201).json({ ok: true, video: { ...video, secureUrl: streamUrl, videoUrl: streamUrl, telegramPlayback: streamUrl } });
      } catch (error) {
        console.error("Telegram direct video upload failed:", error?.message || error);
        return res.status(500).json({ ok: false, error: error?.message || "Video upload is temporarily unavailable." });
      }
    });
    return originalUse.apply(this, args);
  };
}
