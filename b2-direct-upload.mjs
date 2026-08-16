import Busboy from "busboy";
import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { uploadVideoBuffer, getVideoObject, b2StorageConfigured } from "./services/b2-storage.js";
import { canonicalUserRoot, syncCanonicalUser } from "./services/user-canonical.js";
import { saveCanonicalVideo } from "./services/canonical-content.js";

const MAX_FILE_BYTES = 500 * 1024 * 1024;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";

function getFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), databaseURL: DATABASE_URL });
}

async function requireUser(req, res) {
  const app = getFirebase();
  if (!app) return res.status(503).json({ ok: false, error: "Authentication service is unavailable." });
  const header = String(req.headers.authorization || "");
  if (!/^Bearer\s+\S+$/i.test(header)) return res.status(401).json({ ok: false, error: "Authentication required." });
  try {
    return await admin.auth(app).verifyIdToken(header.replace(/^Bearer\s+/i, "").trim(), true);
  } catch {
    res.status(401).json({ ok: false, error: "Invalid or expired authentication token." });
    return null;
  }
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers["content-type"] || "");
    if (!type.startsWith("multipart/form-data")) return reject(new Error("Multipart upload is required."));
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 20 } });
    const fields = {};
    const chunks = [];
    let fileName = "indo-video.mp4";
    let fileMime = "video/mp4";
    let tooLarge = false;
    let sawFile = false;
    busboy.on("field", (name, value) => { fields[name] = String(value || ""); });
    busboy.on("file", (_name, stream, info) => {
      sawFile = true;
      fileName = String(info?.filename || fileName).slice(0, 180);
      fileMime = String(info?.mimeType || fileMime);
      if (!fileMime.startsWith("video/")) {
        stream.resume();
        return reject(new Error("Please select a valid video file."));
      }
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => { tooLarge = true; });
    });
    busboy.on("error", reject);
    busboy.on("finish", () => {
      if (tooLarge) return reject(new Error("Video is larger than the current 500 MB upload limit."));
      if (!sawFile) return reject(new Error("Select a video file first."));
      resolve({ fields, buffer: Buffer.concat(chunks), fileName, fileMime });
    });
    req.pipe(busboy);
  });
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || "").replace(/\/$/, "");
  if (origin === "https://yashwanthputtarajegowda.github.io") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Vary", "Origin");
  }
}

const originalUse = express.application.use;
if (!express.application.__indoB2Upload) {
  express.application.__indoB2Upload = true;
  express.application.use = function indoB2Use(...args) {
    originalUse.call(this, async (req, res, next) => {
      if (req.path === "/api/media/videos/upload" && req.method === "POST") {
        applyCors(req, res);
        if (!b2StorageConfigured()) return res.status(503).json({ ok: false, error: "Backblaze B2 storage is temporarily unavailable." });
        const user = await requireUser(req, res);
        if (!user) return;
        try {
          const { fields, buffer, fileName, fileMime } = await parseMultipart(req);
          const mediaType = String(fields.mediaType || "video").toLowerCase() === "reel" ? "reel" : "video";
          const title = String(fields.title || "").trim().slice(0, 120);
          const caption = String(fields.caption || fields.description || "").trim().slice(0, 500);
          if (!title) return res.status(400).json({ ok: false, error: "Add a title first." });
          const duration = Number(fields.duration || 0), width = Number(fields.width || 0), height = Number(fields.height || 0);
          if (!Number.isFinite(duration) || duration < 0 || duration > 3600 || !Number.isFinite(width) || width < 0 || width > 20000 || !Number.isFinite(height) || height < 0 || height > 20000) {
            return res.status(400).json({ ok: false, error: "Invalid video metadata." });
          }
          const app = getFirebase();
          const db = app ? getDatabaseWithUrl(DATABASE_URL, app) : null;
          if (!db) return res.status(503).json({ ok: false, error: "Database service is unavailable." });
          const profile = (await syncCanonicalUser({ db, uid: user.uid, includeContent: false })).profile;
          const videoRef = db.ref("videos").push();
          const objectKey = `indo/videos/${user.uid}/${videoRef.key}-${encodeURIComponent(fileName).replace(/%/g, "_")}`;
          await uploadVideoBuffer({ buffer, key: objectKey, contentType: fileMime, metadata: { ownerUid: user.uid, mediaType } });
          const streamUrl = `${req.protocol || "https"}://${req.get("host")}/api/media/videos/${encodeURIComponent(videoRef.key)}/stream`;
          const video = {
            id: videoRef.key,
            mediaType,
            ownerUid: user.uid,
            creator: profile.username || `@${user.uid.slice(0, 8)}`,
            creatorName: profile.name || "Indo User",
            title: title || (mediaType === "reel" ? "Untitled reel" : "Untitled video"),
            caption,
            publicId: objectKey,
            secureUrl: streamUrl,
            videoUrl: streamUrl,
            b2: { provider: "backblaze", bucket: String(process.env.B2_BUCKET_NAME || "").trim(), objectKey },
            duration, width, height, views: 0, likes: 0,
            createdAt: admin.database.ServerValue.TIMESTAMP,
            storage: { provider: "backblaze" },
          };
          await videoRef.set(video);
          await saveCanonicalVideo({ db, uid: user.uid, video: { ...video, createdAt: Date.now() } });
          await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => (Number(current) || 0) + 1);
          await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => (Number(current) || 0) + 1);
          return res.status(201).json({ ok: true, video });
        } catch (error) {
          console.error("B2 direct video upload failed:", error?.message || error);
          return res.status(500).json({ ok: false, error: error?.message || "Video upload is temporarily unavailable." });
        }
      }

      if (req.path.startsWith("/api/media/videos/") && req.path.endsWith("/stream") && (req.method === "GET" || req.method === "HEAD")) {
        if (!b2StorageConfigured()) return res.status(503).json({ ok: false, error: "Backblaze B2 storage is temporarily unavailable." });
        try {
          const videoId = decodeURIComponent(req.path.split("/")[4] || "");
          if (!videoId) return res.status(400).json({ ok: false, error: "Video ID is required." });
          const app = getFirebase();
          const db = app ? getDatabaseWithUrl(DATABASE_URL, app) : null;
          if (!db) return res.status(503).json({ ok: false, error: "Database service is unavailable." });
          const snapshot = await db.ref(`videos/${videoId}`).get();
          if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Video not found." });
          const video = snapshot.val() || {};
          const objectKey = String(video?.b2?.objectKey || "").trim();
          if (!objectKey || video?.storage?.provider !== "backblaze") return next();
          const range = String(req.headers.range || "").trim();
          const object = await getVideoObject({ key: objectKey, range: range || undefined });
          res.statusCode = range ? 206 : 200;
          if (object.ContentType) res.setHeader("Content-Type", object.ContentType);
          if (object.ContentLength != null) res.setHeader("Content-Length", String(object.ContentLength));
          if (object.ContentRange) res.setHeader("Content-Range", object.ContentRange);
          if (object.AcceptRanges) res.setHeader("Accept-Ranges", object.AcceptRanges);
          else res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Cache-Control", "public, max-age=3600");
          if (req.method === "HEAD") return res.end();
          object.Body.pipe(res);
          return;
        } catch (error) {
          console.error("B2 video stream failed:", error?.message || error);
          return res.status(502).json({ ok: false, error: "Video stream is temporarily unavailable." });
        }
      }
      return next();
    });
    return originalUse.apply(this, args);
  };
}
