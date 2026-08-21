import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { deleteDriveFile } from "./services/google-drive-storage.js";

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";
const CANONICAL_ROOT = (uid) => `users/${String(uid || "").trim()}`;

function getDb() {
  if (admin.apps.length) return getDatabaseWithUrl(DATABASE_URL, admin.app());
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  const app = admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), databaseURL: DATABASE_URL }, "video-delete-boot");
  return getDatabaseWithUrl(DATABASE_URL, app);
}

function driveFileIdFromVideo(video) {
  return String(video?.googleDrive?.fileId || video?.drive?.fileId || video?.storage?.fileId || video?.googleDriveFileId || "").trim();
}

async function findVideo(db, uid, requestedId) {
  const direct = await db.ref(`videos/${requestedId}`).get();
  if (direct.exists()) return { key: requestedId, video: direct.val() || {} };

  const byObjectId = await db.ref("videos").orderByChild("id").equalTo(requestedId).limitToFirst(5).get();
  const value = byObjectId.val() || {};
  for (const [key, video] of Object.entries(value)) {
    if (video && String(video.ownerUid || "") === String(uid || "")) return { key, video };
  }

  const [canonicalVideo, canonicalPost] = await Promise.all([
    db.ref(`${CANONICAL_ROOT(uid)}/content/videos/${requestedId}`).get(),
    db.ref(`${CANONICAL_ROOT(uid)}/content/posts/${requestedId}`).get(),
  ]);
  const candidate = canonicalVideo.exists() ? canonicalVideo.val() : canonicalPost.exists() ? canonicalPost.val() : null;
  if (candidate) {
    const legacyById = await db.ref("videos").orderByChild("id").equalTo(String(candidate.id || requestedId)).limitToFirst(5).get();
    const matches = legacyById.val() || {};
    for (const [key, video] of Object.entries(matches)) {
      if (video && String(video.ownerUid || "") === String(uid || "")) return { key, video };
    }
    return { key: requestedId, video: candidate, canonicalOnly: true };
  }

  return null;
}

async function requireUser(req, res, auth) {
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

const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  if (path !== "/api/media/videos/:videoId/delete") return originalPost.call(this, path, ...handlers);

  return originalPost.call(this, path, async (req, res) => {
    const db = getDb();
    if (!db) return res.status(503).json({ ok: false, error: "Firebase database is unavailable." });
    const auth = admin.auth(admin.app());
    const user = await requireUser(req, res, auth);
    if (!user) return;

    const requestedId = String(req.params.videoId || "").trim();
    if (!requestedId) return res.status(400).json({ ok: false, error: "Video ID is required." });

    try {
      const found = await findVideo(db, user.uid, requestedId);
      if (!found) return res.status(404).json({ ok: false, error: "Video not found." });

      const { key: recordKey, video } = found;
      if (String(video.ownerUid || "") !== String(user.uid || "")) return res.status(403).json({ ok: false, error: "You can delete only your own video." });

      const provider = String(video.storage?.provider || "").trim().toLowerCase();
      const fileId = driveFileIdFromVideo(video);
      if (provider === "google-drive" && !fileId) return res.status(409).json({ ok: false, error: "Google Drive file ID is missing for this video." });

      if (fileId) await deleteDriveFile(fileId);

      const canonicalId = String(video.id || requestedId).trim();
      const updates = {
        [`videos/${recordKey}`]: null,
        [`${CANONICAL_ROOT(user.uid)}/content/posts/${canonicalId}`]: null,
        [`${CANONICAL_ROOT(user.uid)}/content/videos/${canonicalId}`]: null,
        [`${CANONICAL_ROOT(user.uid)}/engagement/videos/${canonicalId}`]: null,
        [`videoLikes/${canonicalId}`]: null,
        [`videoComments/${canonicalId}`]: null,
        [`videoSaves/${canonicalId}`]: null,
      };
      if (recordKey !== canonicalId) updates[`videos/${canonicalId}`] = null;
      await db.ref().update(updates);

      await db.ref(`${CANONICAL_ROOT(user.uid)}/stats/postsCount`).transaction((current) => Math.max(0, (Number(current) || 0) - 1));
      await db.ref(`${CANONICAL_ROOT(user.uid)}/stats/videosCount`).transaction((current) => Math.max(0, (Number(current) || 0) - 1));

      return res.json({ ok: true, videoId: canonicalId, deleted: true, driveDeleted: Boolean(fileId), matchedRecordKey: recordKey });
    } catch (error) {
      console.error("Robust video delete failed:", error?.stack || error?.message || error);
      return res.status(Number(error?.status) || 500).json({ ok: false, error: String(error?.message || "Could not delete video.").slice(0, 300) });
    }
  });
};
