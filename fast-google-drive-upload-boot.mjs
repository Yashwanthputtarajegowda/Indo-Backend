import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { canonicalUserRoot, syncCanonicalUser } from "./services/user-canonical.js";
import { saveCanonicalVideo } from "./services/canonical-content.js";
import { startResumableDriveUpload, uploadDriveChunk } from "./services/google-drive-storage.js";

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const FAST_CHUNK_BYTES = 32 * 1024 * 1024;
const FAST_INIT = "/api/google-drive/videos/upload-resumable-fast/init";
const FAST_CHUNK = "/api/google-drive/videos/upload-resumable-fast";
const BOOT_VERSION = "20260822-fast-drive-upload-v1";

function getDb() {
  if (admin.apps.length) return getDatabaseWithUrl(DATABASE_URL, admin.app());
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  const app = admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey, databaseURL: DATABASE_URL }, "fast-drive-upload") });
  return getDatabaseWithUrl(DATABASE_URL, app);
}

function text(v, max = 500) { return String(v ?? "").trim().slice(0, max); }
function finite(v, fallback = 0) { return Number.isFinite(Number(v)) ? Number(v) : fallback; }
function bool(v, fallback = true) { return v === undefined || v === null || v === "" ? fallback : String(v).toLowerCase() !== "false"; }
function cleanRealtime(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(cleanRealtime).filter((v) => v !== undefined);
  if (typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const cleaned = cleanRealtime(v);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return out;
}
function metaOf(source = {}) {
  const privacy = ["public", "followers", "private"].includes(text(source.privacy || "public", 20)) ? text(source.privacy || "public", 20) : "public";
  const tags = Array.isArray(source.tags) ? source.tags.slice(0, 20).map((v) => text(v, 60).replace(/^#/, "")).filter(Boolean) : [];
  return {
    mediaType: String(source.mediaType || "video").toLowerCase() === "reel" ? "reel" : "video",
    title: text(source.title, 120) || "Untitled video",
    caption: text(source.caption ?? source.description, 500),
    privacy,
    allowComments: bool(source.allowComments, true),
    allowDuet: bool(source.allowDuet, true),
    category: text(source.category, 60),
    tags,
    location: text(source.location, 120),
    duration: Math.max(0, finite(source.duration)),
    width: Math.max(0, finite(source.width)),
    height: Math.max(0, finite(source.height)),
  };
}
function safeFileName(v) { return text(v, 140).normalize("NFKD").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "indo-video.mp4"; }
async function requireUser(req, res) {
  const auth = admin.apps.length ? admin.auth(admin.app()) : null;
  const header = String(req.headers.authorization || "");
  if (!auth || !/^Bearer\s+\S+$/i.test(header)) { res.status(401).json({ ok: false, error: "Authentication required.", fastUploadVersion: BOOT_VERSION }); return null; }
  try { return await auth.verifyIdToken(header.replace(/^Bearer\s+/i, "").trim(), true); }
  catch { res.status(401).json({ ok: false, error: "Invalid or expired authentication token.", fastUploadVersion: BOOT_VERSION }); return null; }
}
async function persistVideo({ db, user, session, driveFile }) {
  const videoRef = db.ref("videos").push();
  const videoId = String(videoRef.key || "");
  if (!videoId) throw new Error("Could not create video id.");
  const meta = session.meta || {};
  const profile = session.profile || {};
  const base = String(process.env.PUBLIC_BASE_URL || "https://indo-backend-456919073297.asia-south1.run.app").replace(/\/$/, "");
  const streamUrl = `${base}/api/google-drive/videos/${encodeURIComponent(videoId)}/stream`;
  const video = cleanRealtime({
    id: videoId,
    mediaType: meta.mediaType || "video",
    mimeType: session.mimeType || "video/mp4",
    ownerUid: String(user.uid || ""),
    creator: String(profile.username || `@${String(user.uid || "").slice(0, 8)}`),
    creatorName: String(profile.name || "Indo User"),
    title: text(meta.title, 120) || "Untitled video",
    caption: text(meta.caption, 500),
    description: text(meta.caption, 500),
    secureUrl: streamUrl,
    videoUrl: streamUrl,
    streamUrl,
    privacy: meta.privacy || "public",
    allowComments: meta.allowComments !== false,
    allowDuet: meta.allowDuet !== false,
    category: text(meta.category, 60),
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    location: text(meta.location, 120),
    duration: finite(meta.duration),
    width: finite(meta.width),
    height: finite(meta.height),
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    createdAt: Date.now(),
    storage: { provider: "google-drive", mode: "backend-fast-resumable-range-stream" },
    googleDrive: {
      provider: "google-drive",
      fileId: String(driveFile?.id || ""),
      fileName: String(driveFile?.name || session.fileName || "indo-video.mp4"),
      mimeType: String(session.mimeType || "video/mp4"),
      size: finite(driveFile?.size, 0),
      folderId: String(session.folderId || ""),
    },
  });
  await videoRef.set(video);
  await saveCanonicalVideo({ db, uid: user.uid, video });
  await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((v) => (Number(v) || 0) + 1);
  await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((v) => (Number(v) || 0) + 1);
  return video;
}

const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  if (path === FAST_INIT) {
    return originalPost.call(this, path, async (req, res) => {
      const user = await requireUser(req, res); if (!user) return;
      const db = getDb(); if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
      try {
        if (!process.env.GOOGLE_DRIVE_REFRESH_TOKEN) return res.status(503).json({ ok: false, error: "Google Drive is not authorized." });
        const body = req.body || {};
        const totalSize = Math.max(0, Math.floor(finite(body.totalSize)));
        const mimeType = String(body.mimeType || "video/mp4").split(";")[0].trim().toLowerCase();
        if (!mimeType.startsWith("video/")) return res.status(400).json({ ok: false, error: "Only video uploads are supported." });
        if (!totalSize || totalSize > MAX_VIDEO_BYTES) return res.status(413).json({ ok: false, error: "Video must be between 1 byte and 500 MB." });
        const fileName = safeFileName(body.fileName || "indo-video.mp4");
        const profile = (await syncCanonicalUser({ db, uid: user.uid, includeContent: false })).profile || {};
        const { sessionUrl, folderId } = await startResumableDriveUpload({ fileName, mimeType, folderId: process.env.GOOGLE_DRIVE_FOLDER_ID });
        const uploadId = String(db.ref("googleDriveUploadSessions").push().key || "");
        if (!uploadId) throw new Error("Could not create upload session.");
        await db.ref(`googleDriveUploadSessions/${uploadId}`).set(cleanRealtime({
          ownerUid: String(user.uid), sessionUrl, fileName, mimeType, totalSize, folderId: String(folderId || ""), nextOffset: 0,
          meta: metaOf(body), profile: { username: String(profile.username || ""), name: String(profile.name || "") }, createdAt: Date.now(), updatedAt: Date.now(), fastUploadVersion: BOOT_VERSION,
        }));
        return res.status(201).json({ ok: true, uploadId, chunkSize: FAST_CHUNK_BYTES, nextOffset: 0, fastUploadVersion: BOOT_VERSION });
      } catch (error) { console.error("Fast Drive init failed:", error?.stack || error?.message || error); return res.status(502).json({ ok: false, error: text(error?.message || "Could not start fast upload.", 300), fastUploadVersion: BOOT_VERSION }); }
    });
  }
  if (path === `${FAST_CHUNK}/:uploadId`) {
    return originalPost.call(this, path, express.raw({ type: () => true, limit: "40mb" }), async (req, res) => {
      const user = await requireUser(req, res); if (!user) return;
      const db = getDb(); if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
      const uploadId = text(req.params.uploadId, 200);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const start = Math.max(0, Math.floor(finite(req.query.start, -1)));
      const total = Math.max(0, Math.floor(finite(req.query.total, -1)));
      if (!body.length) return res.status(400).json({ ok: false, error: "Upload chunk is empty." });
      if (body.length > FAST_CHUNK_BYTES) return res.status(413).json({ ok: false, error: "Upload chunk is too large." });
      try {
        const ref = db.ref(`googleDriveUploadSessions/${uploadId}`);
        const snap = await ref.get();
        if (!snap.exists()) return res.status(404).json({ ok: false, error: "Upload session not found or expired." });
        const session = snap.val() || {};
        if (String(session.ownerUid || "") !== String(user.uid || "") || Number(session.totalSize) !== total || Number(session.nextOffset || 0) !== start) return res.status(409).json({ ok: false, error: "Upload session mismatch.", nextOffset: Number(session.nextOffset || 0) });
        const end = start + body.length - 1;
        if (end >= total) return res.status(400).json({ ok: false, error: "Upload chunk exceeds the declared file size." });
        const result = await uploadDriveChunk({ sessionUrl: String(session.sessionUrl || ""), body, start, end, total });
        if (!result.complete) { const nextOffset = Number(result.nextOffset || end + 1); await ref.update({ nextOffset, updatedAt: Date.now() }); return res.json({ ok: true, complete: false, nextOffset, fastUploadVersion: BOOT_VERSION }); }
        const video = await persistVideo({ db, user, session, driveFile: result.file });
        await ref.remove();
        return res.status(201).json({ ok: true, complete: true, video, fastUploadVersion: BOOT_VERSION });
      } catch (error) { console.error("Fast Drive chunk failed:", error?.stack || error?.message || error); return res.status(502).json({ ok: false, error: text(error?.message || "Could not upload video chunk.", 300), fastUploadVersion: BOOT_VERSION }); }
    });
  }
  return originalPost.call(this, path, ...handlers);
};
