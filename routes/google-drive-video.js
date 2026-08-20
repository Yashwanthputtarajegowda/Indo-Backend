import express from "express";
import { canonicalUserRoot, syncCanonicalUser } from "../services/user-canonical.js";
import { saveCanonicalVideo } from "../services/canonical-content.js";
import {
  exchangeAuthorizationCode,
  getGoogleDriveAuthorizationUrl,
  getDriveFile,
  getDriveStream,
  findDriveFolderId,
  googleDriveConfigured,
  startResumableDriveUpload,
  uploadDriveChunk,
  uploadVideoToDrive,
} from "../services/google-drive-storage.js";

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;

const text = (value, max = 500) => String(value ?? "").trim().slice(0, max);
const safeFileName = (value) => text(value, 140).normalize("NFKD").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "indo-video.mp4";
const bool = (value, fallback = true) => value === undefined || value === null || value === "" ? fallback : String(value).toLowerCase() !== "false";
const finiteNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function cleanForRealtime(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(cleanForRealtime).filter((item) => item !== undefined);
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const cleaned = cleanForRealtime(item);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

function getVideoMeta(source = {}) {
  const privacyRaw = text(source.privacy || "public", 20);
  const tags = Array.isArray(source.tags)
    ? source.tags.map((v) => text(v, 60).replace(/^#/, "")).filter(Boolean).slice(0, 20)
    : String(source.tags || "").split(",").map((v) => v.trim().replace(/^#/, "")).filter(Boolean).slice(0, 20);
  return {
    mediaType: String(source.mediaType || "video").toLowerCase() === "reel" ? "reel" : "video",
    title: text(source.title, 120) || "Untitled video",
    caption: text(source.caption ?? source.description, 500),
    privacy: ["public", "followers", "private"].includes(privacyRaw) ? privacyRaw : "public",
    allowComments: bool(source.allowComments, true),
    allowDuet: bool(source.allowDuet, true),
    category: text(source.category, 60),
    tags,
    location: text(source.location, 120),
    duration: Math.max(0, finiteNumber(source.duration)),
    width: Math.max(0, finiteNumber(source.width)),
    height: Math.max(0, finiteNumber(source.height)),
  };
}

async function persistDriveVideo({ database, user, profile, driveFile, fileName, mimeType, meta: rawMeta }) {
  const meta = getVideoMeta(rawMeta || {});
  const videoRef = database.ref("videos").push();
  const videoId = String(videoRef.key || "");
  if (!videoId) throw new Error("Could not create video id.");
  const baseUrl = String(process.env.PUBLIC_BASE_URL || "https://indo-backend-456919073297.asia-south1.run.app").replace(/\/$/, "");
  const streamUrl = `${baseUrl}/api/google-drive/videos/${encodeURIComponent(videoId)}/stream`;
  const video = cleanForRealtime({
    id: videoId,
    mediaType: meta.mediaType,
    mimeType: String(mimeType || "video/mp4"),
    ownerUid: String(user.uid || ""),
    creator: String(profile?.username || `@${String(user.uid || "").slice(0, 8)}`),
    creatorName: String(profile?.name || "Indo User"),
    title: meta.title,
    caption: meta.caption,
    description: meta.caption,
    secureUrl: streamUrl,
    videoUrl: streamUrl,
    streamUrl,
    privacy: meta.privacy,
    allowComments: meta.allowComments,
    allowDuet: meta.allowDuet,
    category: meta.category,
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    location: meta.location,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    createdAt: Date.now(),
    storage: { provider: "google-drive", mode: "backend-resumable-range-stream" },
    googleDrive: {
      provider: "google-drive",
      fileId: String(driveFile?.id || ""),
      fileName: String(driveFile?.name || fileName || "indo-video.mp4"),
      mimeType: String(mimeType || "video/mp4"),
      size: finiteNumber(driveFile?.size, 0),
      folderId: String(driveFile?.folderId || ""),
    },
  });
  await videoRef.set(video);
  await saveCanonicalVideo({ db: database, uid: user.uid, video });
  await database.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => (Number(current) || 0) + 1);
  await database.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => (Number(current) || 0) + 1);
  return video;
}

function normalizeDriveRange(rangeHeader, total) {
  const raw = String(rangeHeader || "").trim();
  if (!raw || !Number.isFinite(total) || total <= 0) return "";
  const match = raw.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return "";
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null && end !== null) {
    const suffixLength = Math.max(0, end);
    if (!suffixLength) return "";
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else if (start !== null && end === null) {
    end = total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) return "";
  end = Math.min(end, total - 1);
  return `bytes=${start}-${end}`;
}

export function createGoogleDriveVideoRouter({ db, requireUser }) {
  const router = express.Router();

  router.get("/google-drive/auth", (_req, res) => {
    if (!googleDriveConfigured()) return res.status(503).json({ ok: false, error: "Google Drive OAuth is not configured." });
    return res.redirect(getGoogleDriveAuthorizationUrl());
  });

  router.get("/oauth2callback", async (req, res) => {
    const code = String(req.query.code || "").trim();
    const error = String(req.query.error || "").trim();
    if (error) return res.status(400).send(`Google authorization was denied: ${error}`);
    if (!code) return res.status(400).send("Google authorization code is missing.");
    try {
      const token = await exchangeAuthorizationCode(code);
      const refreshToken = String(token.refresh_token || "");
      return res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Indo Drive Authorization</title></head><body style="font-family:system-ui;padding:24px"><h2>Google Drive authorization complete</h2><p>Copy the refresh token below into Cloud Run as <b>GOOGLE_DRIVE_REFRESH_TOKEN</b>.</p><textarea style="width:100%;min-height:120px">${refreshToken.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</textarea><p>After saving the variable, redeploy the backend.</p></body></html>`);
    } catch (err) {
      return res.status(502).send(`Google authorization failed: ${String(err?.message || err).replace(/[<>]/g, "")}`);
    }
  });

  router.get("/google-drive/status", async (_req, res) => {
    if (!googleDriveConfigured()) return res.json({ ok: false, configured: false, authorized: false });
    try {
      if (!process.env.GOOGLE_DRIVE_REFRESH_TOKEN) return res.json({ ok: true, configured: true, authorized: false, folderId: null, folder: null });
      const folderId = await findDriveFolderId();
      const folder = await getDriveFile(folderId);
      return res.json({ ok: true, configured: true, authorized: true, folderId, folder });
    } catch (err) {
      return res.status(502).json({ ok: false, configured: true, authorized: false, error: err?.message || "Google Drive authorization or folder access is not working." });
    }
  });

  router.post("/google-drive/videos/upload-resumable/init", async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    if (!process.env.GOOGLE_DRIVE_REFRESH_TOKEN) return res.status(503).json({ ok: false, error: "Google Drive is not authorized." });
    try {
      const body = req.body || {};
      const totalSize = Math.max(0, Math.floor(finiteNumber(body.totalSize)));
      const mimeType = String(body.mimeType || "video/mp4").split(";")[0].trim().toLowerCase();
      if (!mimeType.startsWith("video/")) return res.status(400).json({ ok: false, error: "Only video uploads are supported." });
      if (!totalSize) return res.status(400).json({ ok: false, error: "Video file is missing." });
      if (totalSize > MAX_VIDEO_BYTES) return res.status(413).json({ ok: false, error: "Video must be 500 MB or smaller." });
      const fileName = safeFileName(body.fileName || "indo-video.mp4");
      const meta = getVideoMeta(body);
      const profile = (await syncCanonicalUser({ db, uid: user.uid, includeContent: false })).profile || {};
      const { sessionUrl, folderId } = await startResumableDriveUpload({ fileName, mimeType, folderId: process.env.GOOGLE_DRIVE_FOLDER_ID });
      const uploadId = String(db.ref("googleDriveUploadSessions").push().key || "");
      if (!uploadId) throw new Error("Could not create upload session.");
      await db.ref(`googleDriveUploadSessions/${uploadId}`).set(cleanForRealtime({
        ownerUid: String(user.uid),
        sessionUrl: String(sessionUrl),
        fileName,
        mimeType,
        totalSize,
        folderId: String(folderId || ""),
        nextOffset: 0,
        meta: { ...meta, tags: Array.isArray(meta.tags) ? meta.tags : [] },
        profile: { username: String(profile.username || ""), name: String(profile.name || "") },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      return res.status(201).json({ ok: true, uploadId, chunkSize: RESUMABLE_CHUNK_BYTES, nextOffset: 0 });
    } catch (err) {
      console.error("Google Drive resumable init failed:", err?.message || err);
      return res.status(502).json({ ok: false, error: String(err?.message || "Could not start Google Drive upload.").slice(0, 300) });
    }
  });

  router.post("/google-drive/videos/upload-resumable/:uploadId", express.raw({ type: () => true, limit: "10mb" }), async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const uploadId = text(req.params.uploadId, 200);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const start = Math.max(0, Math.floor(finiteNumber(req.query.start, -1)));
    const total = Math.max(0, Math.floor(finiteNumber(req.query.total, -1)));
    if (!body.length) return res.status(400).json({ ok: false, error: "Upload chunk is empty." });
    if (body.length > RESUMABLE_CHUNK_BYTES) return res.status(413).json({ ok: false, error: "Upload chunk is too large." });
    if (start < 0 || total <= 0) return res.status(400).json({ ok: false, error: "Upload offset or total size is invalid." });
    try {
      const sessionRef = db.ref(`googleDriveUploadSessions/${uploadId}`);
      const snapshot = await sessionRef.get();
      if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Upload session not found or expired." });
      const session = snapshot.val() || {};
      if (String(session.ownerUid || "") !== String(user.uid || "")) return res.status(403).json({ ok: false, error: "You do not own this upload." });
      if (Number(session.totalSize) !== total) return res.status(400).json({ ok: false, error: "Upload total size does not match the upload session." });
      if (Number(session.nextOffset || 0) !== start) return res.status(409).json({ ok: false, error: "Upload offset mismatch.", nextOffset: Number(session.nextOffset || 0) });
      const end = start + body.length - 1;
      if (end >= total) return res.status(400).json({ ok: false, error: "Upload chunk exceeds the declared file size." });
      const result = await uploadDriveChunk({ sessionUrl: String(session.sessionUrl || ""), body, start, end, total });
      if (!result.complete) {
        const nextOffset = Number(result.nextOffset || end + 1);
        await sessionRef.update({ nextOffset, updatedAt: Date.now() });
        return res.json({ ok: true, complete: false, nextOffset });
      }
      const meta = getVideoMeta(session.meta || {});
      const profile = session.profile || {};
      const video = await persistDriveVideo({ database: db, user, profile, driveFile: { ...result.file, folderId: session.folderId }, fileName: session.fileName, mimeType: session.mimeType, meta });
      await sessionRef.remove();
      return res.status(201).json({ ok: true, complete: true, video });
    } catch (err) {
      console.error("Google Drive resumable chunk failed:", err?.message || err);
      return res.status(502).json({ ok: false, error: String(err?.message || "Could not upload video chunk to Google Drive.").slice(0, 300) });
    }
  });

  router.post("/google-drive/videos/upload", express.raw({ type: () => true, limit: "500mb" }), async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    if (!process.env.GOOGLE_DRIVE_REFRESH_TOKEN) return res.status(503).json({ ok: false, error: "Google Drive is not authorized." });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mimeType = String(req.headers["content-type"] || "video/mp4").split(";")[0].trim().toLowerCase();
    if (!mimeType.startsWith("video/")) return res.status(400).json({ ok: false, error: "Only video uploads are supported." });
    if (!body.length) return res.status(400).json({ ok: false, error: "Video file is missing." });
    if (body.length > MAX_VIDEO_BYTES) return res.status(413).json({ ok: false, error: "Video must be 500 MB or smaller." });
    try {
      const profile = (await syncCanonicalUser({ db, uid: user.uid, includeContent: false })).profile || {};
      const meta = getVideoMeta({
        mediaType: req.query.mediaType || req.headers["x-media-type"],
        title: req.query.title || req.headers["x-title"],
        caption: req.query.caption || req.headers["x-caption"],
        privacy: req.query.privacy || req.headers["x-privacy"],
        allowComments: req.query.allowComments ?? req.headers["x-allow-comments"],
        allowDuet: req.query.allowDuet ?? req.headers["x-allow-duet"],
        category: req.query.category || req.headers["x-category"],
        tags: req.query.tags || req.headers["x-tags"],
        location: req.query.location || req.headers["x-location"],
        duration: req.query.duration || req.headers["x-duration"],
        width: req.query.width || req.headers["x-width"],
        height: req.query.height || req.headers["x-height"],
      });
      const fileName = safeFileName(req.query.fileName || req.headers["x-file-name"] || "indo-video.mp4");
      const driveFile = await uploadVideoToDrive({ body, fileName, mimeType });
      const video = await persistDriveVideo({ database: db, user, profile, driveFile, fileName, mimeType, meta });
      return res.status(201).json({ ok: true, video });
    } catch (err) {
      console.error("Google Drive video upload failed:", err?.message || err);
      return res.status(502).json({ ok: false, error: String(err?.message || "Could not upload video to Google Drive.").slice(0, 300) });
    }
  });

  const streamHandler = async (req, res) => {
    if (!db) return res.status(503).end();
    const videoId = text(req.params.videoId, 200);
    try {
      const snapshot = await db.ref(`videos/${videoId}`).get();
      if (!snapshot.exists()) return res.status(404).end();
      const video = snapshot.val() || {};
      if (String(video.storage?.provider || "").toLowerCase() !== "google-drive") return res.status(404).end();
      const fileId = text(video.googleDrive?.fileId, 300);
      if (!fileId) return res.status(404).end();

      const file = await getDriveFile(fileId);
      const total = Math.max(0, finiteNumber(file.size, 0));
      const rangeHeader = String(req.headers.range || "").trim();

      if (req.method === "HEAD") {
        res.set({
          "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=60",
          "Accept-Ranges": "bytes",
          "Content-Disposition": "inline",
          "X-Content-Type-Options": "nosniff",
          "Content-Type": String(file.mimeType || video.mimeType || "video/mp4"),
        });
        if (total > 0) res.set("Content-Length", String(total));
        return res.status(200).end();
      }

      const driveRange = normalizeDriveRange(rangeHeader, total);
      const upstream = await getDriveStream(fileId, driveRange, "GET");
      if (!upstream.ok || !upstream.body) {
        console.error("Google Drive media request failed:", upstream.status, upstream.statusText || "", fileId, driveRange);
        return res.status(upstream.status || 502).end();
      }

      const headers = {
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=60",
        "Accept-Ranges": String(upstream.headers.get("accept-ranges") || "bytes"),
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Type": String(upstream.headers.get("content-type") || file.mimeType || video.mimeType || "video/mp4"),
      };
      const contentLength = upstream.headers.get("content-length");
      const contentRange = upstream.headers.get("content-range");
      if (contentLength) headers["Content-Length"] = contentLength;
      if (contentRange) headers["Content-Range"] = contentRange;
      res.status(upstream.status).set(headers);

      const reader = upstream.body.getReader();
      const onClose = () => { try { reader.cancel(); } catch {} };
      res.once("close", onClose);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once("drain", resolve));
        }
        if (!res.writableEnded) res.end();
      } catch (err) {
        console.error("Google Drive stream body failed:", err?.message || err);
        if (!res.headersSent) res.status(502).end();
        else res.destroy(err);
      } finally {
        res.off("close", onClose);
        try { reader.releaseLock(); } catch {}
      }
      return;
    } catch (err) {
      console.error("Google Drive stream failed:", err?.stack || err?.message || err);
      if (res.headersSent) return res.destroy(err);
      return res.status(502).end();
    }
  };

  router.get("/google-drive/videos/:videoId/stream", streamHandler);
  router.head("/google-drive/videos/:videoId/stream", streamHandler);

  return router;
}
