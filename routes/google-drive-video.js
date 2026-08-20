import express from "express";
import admin from "firebase-admin";
import { canonicalUserRoot, syncCanonicalUser } from "../services/user-canonical.js";
import { saveCanonicalVideo } from "../services/canonical-content.js";
import {
  exchangeAuthorizationCode,
  getGoogleDriveAuthorizationUrl,
  getDriveFile,
  getDriveStream,
  findDriveFolderId,
  googleDriveConfigured,
  uploadVideoToDrive,
} from "../services/google-drive-storage.js";

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

function text(value, max = 500) { return String(value ?? "").trim().slice(0, max); }
function safeFileName(value) { return text(value, 140).normalize("NFKD").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "indo-video.mp4"; }
function bool(value, fallback = true) { if (value === undefined || value === null || value === "") return fallback; return String(value).toLowerCase() !== "false"; }
function finiteNumber(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function setStreamHeaders(res) { res.set({ "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=60", "Accept-Ranges": "bytes", "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff" }); }

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
      return res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Indo Drive Authorization</title></head><body style="font-family:system-ui;padding:24px"><h2>Google Drive authorization complete</h2><p>Copy the refresh token below into Cloud Run as <b>GOOGLE_DRIVE_REFRESH_TOKEN</b>. Do not share it publicly.</p><textarea style="width:100%;min-height:120px">${refreshToken.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</textarea><p>After saving the variable, redeploy the backend.</p></body></html>`);
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

  const uploadHandler = async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    if (!process.env.GOOGLE_DRIVE_REFRESH_TOKEN) return res.status(503).json({ ok: false, error: "Google Drive is not authorized. Open /api/google-drive/auth first." });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mimeType = String(req.headers["content-type"] || "video/mp4").split(";")[0].trim().toLowerCase();
    if (!mimeType.startsWith("video/")) return res.status(400).json({ ok: false, error: "Only video uploads are supported." });
    if (!body.length) return res.status(400).json({ ok: false, error: "Video file is missing." });
    if (body.length > MAX_VIDEO_BYTES) return res.status(413).json({ ok: false, error: "Video must be 500 MB or smaller." });
    try {
      const profile = (await syncCanonicalUser({ db, uid: user.uid, includeContent: false })).profile;
      const mediaType = String(req.query.mediaType || req.headers["x-media-type"] || "video").toLowerCase() === "reel" ? "reel" : "video";
      const title = text(req.query.title || req.headers["x-title"], 120) || "Untitled video";
      const caption = text(req.query.caption || req.headers["x-caption"], 500);
      const privacyRaw = text(req.query.privacy || req.headers["x-privacy"] || "public", 20);
      const privacy = ["public", "followers", "private"].includes(privacyRaw) ? privacyRaw : "public";
      const tags = String(req.query.tags || req.headers["x-tags"] || "").split(",").map((v) => v.trim().replace(/^#/, "")).filter(Boolean).slice(0, 20);
      const duration = Math.max(0, finiteNumber(req.query.duration || req.headers["x-duration"]));
      const width = Math.max(0, finiteNumber(req.query.width || req.headers["x-width"]));
      const height = Math.max(0, finiteNumber(req.query.height || req.headers["x-height"]));
      const fileName = safeFileName(req.query.fileName || req.headers["x-file-name"] || "indo-video.mp4");
      const driveFile = await uploadVideoToDrive({ body, fileName, mimeType });
      const videoRef = db.ref("videos").push();
      const videoId = String(videoRef.key);
      const baseUrl = `${req.protocol || "https"}://${req.get("host")}`;
      const streamUrl = `${baseUrl}/api/google-drive/videos/${encodeURIComponent(videoId)}/stream`;
      const driveSize = finiteNumber(driveFile?.size, body.length);
      const video = {
        id: videoId, mediaType, mimeType, ownerUid: user.uid,
        creator: String(profile.username || `@${String(user.uid).slice(0, 8)}`), creatorName: String(profile.name || "Indo User"),
        title, caption, description: caption, secureUrl: streamUrl, videoUrl: streamUrl, streamUrl,
        privacy, allowComments: bool(req.query.allowComments ?? req.headers["x-allow-comments"], true), allowDuet: bool(req.query.allowDuet ?? req.headers["x-allow-duet"], true),
        category: text(req.query.category || req.headers["x-category"], 60), tags,
        location: text(req.query.location || req.headers["x-location"], 120), duration, width, height,
        views: 0, likes: 0, comments: 0, shares: 0, saves: 0, createdAt: Date.now(),
        storage: { provider: "google-drive", mode: "backend-range-stream" },
        googleDrive: { provider: "google-drive", fileId: String(driveFile.id), fileName: String(driveFile.name || fileName), mimeType, size: driveSize, folderId: String(driveFile.folderId || "") },
      };
      await videoRef.set(video);
      await saveCanonicalVideo({ db, uid: user.uid, video });
      await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => (Number(current) || 0) + 1);
      await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => (Number(current) || 0) + 1);
      return res.status(201).json({ ok: true, video });
    } catch (err) {
      console.error("Google Drive video upload failed:", err?.message || err);
      return res.status(502).json({ ok: false, error: err?.message || "Could not upload video to Google Drive." });
    }
  };

  router.post("/google-drive/videos/upload", express.raw({ type: () => true, limit: "500mb" }), uploadHandler);

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
      const metadata = await getDriveFile(fileId);
      const range = String(req.headers.range || "").trim();
      const upstream = await getDriveStream(fileId, range, req.method === "HEAD" ? "HEAD" : "GET");
      if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status === 403 ? 502 : upstream.status).end();
      const mimeType = String(upstream.headers.get("content-type") || metadata.mimeType || video.mimeType || "video/mp4");
      const length = finiteNumber(upstream.headers.get("content-length") || metadata.size, 0);
      const contentRange = String(upstream.headers.get("content-range") || "");
      setStreamHeaders(res);
      res.set("Content-Type", mimeType);
      if (length > 0) res.set("Content-Length", String(length));
      if (contentRange) res.set("Content-Range", contentRange);
      res.status(upstream.status === 206 ? 206 : 200);
      if (req.method === "HEAD") return res.end();
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
      console.error("Google Drive video stream failed:", err?.message || err);
      if (!res.headersSent) return res.status(502).end();
      res.destroy(err);
    }
  };

  router.get("/google-drive/videos/:videoId/stream", streamHandler);
  router.head("/google-drive/videos/:videoId/stream", streamHandler);
  return router;
}
