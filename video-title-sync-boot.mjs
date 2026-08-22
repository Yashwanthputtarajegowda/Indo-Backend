import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";
const TITLE_SYNC_VERSION = "20260822-drive-title-sync-v1";

function getDb() {
  if (admin.apps.length) return getDatabaseWithUrl(DATABASE_URL, admin.app());
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  const app = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL: DATABASE_URL,
  }, "video-title-sync-boot");
  return getDatabaseWithUrl(DATABASE_URL, app);
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

async function requireUser(req, res) {
  const header = clean(req.headers.authorization, 200);
  if (!/^Bearer\s+\S+$/i.test(header)) {
    res.status(401).json({ ok: false, error: "Authentication required.", titleSyncVersion: TITLE_SYNC_VERSION });
    return null;
  }
  if (!admin.apps.length) return res.status(503).json({ ok: false, error: "Authentication service is unavailable.", titleSyncVersion: TITLE_SYNC_VERSION });
  try {
    return await admin.auth(admin.app()).verifyIdToken(header.replace(/^Bearer\s+/i, "").trim(), true);
  } catch {
    res.status(401).json({ ok: false, error: "Invalid or expired authentication token.", titleSyncVersion: TITLE_SYNC_VERSION });
    return null;
  }
}

async function getGoogleAccessToken() {
  const clientId = clean(process.env.GOOGLE_DRIVE_CLIENT_ID, 500);
  const clientSecret = clean(process.env.GOOGLE_DRIVE_CLIENT_SECRET, 500);
  const refreshToken = clean(process.env.GOOGLE_DRIVE_REFRESH_TOKEN, 2000);
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Google Drive authorization is not configured.");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) throw new Error(data?.error_description || "Could not refresh Google Drive access token.");
  return String(data.access_token);
}

async function renameDriveFile(fileId, name) {
  const token = await getGoogleAccessToken();
  const safeTitle = clean(name, 120);
  if (!safeTitle) throw new Error("Video title is empty.");
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType&supportsAllDrives=true`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: safeTitle }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id) throw new Error(data?.error?.message || `Could not rename Google Drive file (${response.status}).`);
  return data;
}

const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  if (path !== "/api/google-drive/videos/:videoId/title") return originalPost.call(this, path, ...handlers);

  return originalPost.call(this, path, async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    const db = getDb();
    if (!db) return res.status(503).json({ ok: false, error: "Firebase database is unavailable.", titleSyncVersion: TITLE_SYNC_VERSION });

    const videoId = clean(req.params.videoId, 500);
    const title = clean(req.body?.title, 120);
    if (!videoId) return res.status(400).json({ ok: false, error: "Video ID is required.", titleSyncVersion: TITLE_SYNC_VERSION });
    if (!title) return res.status(400).json({ ok: false, error: "Video title is required.", titleSyncVersion: TITLE_SYNC_VERSION });

    try {
      const snapshot = await db.ref(`videos/${videoId}`).get();
      if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Video not found.", titleSyncVersion: TITLE_SYNC_VERSION });
      const video = snapshot.val() || {};
      if (String(video.ownerUid || "") !== String(user.uid || "")) return res.status(403).json({ ok: false, error: "You can rename only your own video.", titleSyncVersion: TITLE_SYNC_VERSION });
      const fileId = clean(video.googleDrive?.fileId || video.drive?.fileId || video.storage?.fileId || video.googleDriveFileId, 300);
      if (!fileId) return res.status(409).json({ ok: false, error: "Google Drive file ID is missing for this video.", titleSyncVersion: TITLE_SYNC_VERSION });

      const driveFile = await renameDriveFile(fileId, title);
      await db.ref(`videos/${videoId}/title`).set(title);
      await db.ref(`videos/${videoId}/googleDrive/fileName`).set(String(driveFile.name || title));
      await db.ref(`users/${user.uid}/content/videos/${videoId}/title`).set(title);
      await db.ref(`users/${user.uid}/content/videos/${videoId}/googleDrive/fileName`).set(String(driveFile.name || title));
      await db.ref(`users/${user.uid}/content/posts/${videoId}/title`).set(title);
      await db.ref(`users/${user.uid}/content/posts/${videoId}/googleDrive/fileName`).set(String(driveFile.name || title));

      return res.json({ ok: true, videoId, title, driveFileName: String(driveFile.name || title), titleSyncVersion: TITLE_SYNC_VERSION });
    } catch (error) {
      console.error("Drive title sync failed:", error?.stack || error?.message || error);
      return res.status(Number(error?.status) || 502).json({ ok: false, error: String(error?.message || "Could not sync title to Google Drive.").slice(0, 300), titleSyncVersion: TITLE_SYNC_VERSION });
    }
  });
};
