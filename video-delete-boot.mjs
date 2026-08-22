import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { deleteDriveFile } from "./services/google-drive-storage.js";

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";
const CANONICAL_ROOT = (uid) => `users/${String(uid || "").trim()}`;
const DELETE_BOOT_VERSION = "20260822-delete-firebase-resolver-v4";

function getDb() {
  if (admin.apps.length) return getDatabaseWithUrl(DATABASE_URL, admin.app());
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  const app = admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), databaseURL: DATABASE_URL }, "video-delete-boot");
  return getDatabaseWithUrl(DATABASE_URL, app);
}

function clean(value, max = 300) { return String(value ?? "").trim().slice(0, max); }
function ownerUidFromVideo(video = {}) {
  return clean(video.ownerUid || video.uid || video.userId || video.creatorUid || video.owner?.uid || video.user?.uid, 160);
}
function driveFileIdFromVideo(video = {}) {
  return clean(video?.googleDrive?.fileId || video?.drive?.fileId || video?.storage?.fileId || video?.googleDriveFileId, 300);
}
function candidateValues(video = {}, key = "") {
  const external = video?.external || {};
  const googleDrive = video?.googleDrive || {};
  return [
    key, video?.id, video?.videoId, video?.mediaId, video?.publicId, video?.recordId,
    video?.sourceId, video?.secureUrl, video?.videoUrl, video?.streamUrl, video?.url,
    video?.sourceUrl, external?.sourceUrl, googleDrive?.fileId,
  ].map((value) => clean(value, 500)).filter(Boolean);
}
function matchesRequested(video, key, requestedId) {
  const requested = clean(requestedId, 500);
  return candidateValues(video, key).includes(requested);
}

async function findVideo(db, uid, requestedId) {
  const requested = clean(requestedId, 500);
  if (!requested) return null;
  const owner = clean(uid, 160);

  // Firebase legacy collection: exact key first.
  const direct = await db.ref(`videos/${requested}`).get();
  if (direct.exists()) {
    const video = direct.val() || {};
    const videoOwner = ownerUidFromVideo(video);
    if (!videoOwner || videoOwner === owner) return { key: requested, video, match: "videos-key" };
  }

  // Firebase legacy collection: scan all records for id/publicId/mediaId,
  // stream URL or Drive file ID. Delete is infrequent, so correctness wins.
  const all = (await db.ref("videos").get()).val() || {};
  for (const [key, video] of Object.entries(all)) {
    if (!video || typeof video !== "object") continue;
    const videoOwner = ownerUidFromVideo(video);
    if (videoOwner && videoOwner !== owner) continue;
    if (matchesRequested(video, key, requested)) return { key, video, match: "videos-field" };
  }

  // Canonical per-user trees: scan by key and all known logical identifiers.
  const root = CANONICAL_ROOT(owner);
  const [videosSnap, postsSnap] = await Promise.all([
    db.ref(`${root}/content/videos`).get(),
    db.ref(`${root}/content/posts`).get(),
  ]);
  for (const [key, video] of [
    ...Object.entries(videosSnap.val() || {}),
    ...Object.entries(postsSnap.val() || {}),
  ]) {
    if (!video || typeof video !== "object") continue;
    if (matchesRequested(video, key, requested)) return { key, video, canonicalOnly: true, match: "canonical-field" };
  }

  return null;
}

async function requireUser(req, res, auth) {
  const header = clean(req.headers.authorization, 200);
  if (!/^Bearer\s+\S+$/i.test(header)) {
    res.status(401).json({ ok: false, error: "Authentication required.", deleteBootVersion: DELETE_BOOT_VERSION });
    return null;
  }
  try {
    return await auth.verifyIdToken(header.replace(/^Bearer\s+/i, "").trim(), true);
  } catch {
    res.status(401).json({ ok: false, error: "Invalid or expired authentication token.", deleteBootVersion: DELETE_BOOT_VERSION });
    return null;
  }
}

const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  if (path !== "/api/media/videos/:videoId/delete") return originalPost.call(this, path, ...handlers);

  return originalPost.call(this, path, async (req, res) => {
    const db = getDb();
    if (!db) return res.status(503).json({ ok: false, error: "Firebase database is unavailable.", deleteBootVersion: DELETE_BOOT_VERSION });
    const auth = admin.auth(admin.app());
    const user = await requireUser(req, res, auth);
    if (!user) return;

    const requestedId = clean(req.params.videoId, 500);
    if (!requestedId) return res.status(400).json({ ok: false, error: "Video ID is required.", deleteBootVersion: DELETE_BOOT_VERSION });

    try {
      const found = await findVideo(db, user.uid, requestedId);
      if (!found) {
        return res.status(404).json({
          ok: false,
          error: "Video not found.",
          deleteBootVersion: DELETE_BOOT_VERSION,
          checkedFirebasePaths: ["videos/<key>", "videos/*", `${CANONICAL_ROOT(user.uid)}/content/videos/*`, `${CANONICAL_ROOT(user.uid)}/content/posts/*`],
        });
      }

      const { key: recordKey, video } = found;
      const ownerUid = ownerUidFromVideo(video) || String(user.uid || "");
      if (ownerUid !== String(user.uid || "")) return res.status(403).json({ ok: false, error: "You can delete only your own video.", deleteBootVersion: DELETE_BOOT_VERSION });

      const provider = clean(video.storage?.provider, 80).toLowerCase();
      const fileId = driveFileIdFromVideo(video);
      if (provider === "google-drive" && !fileId) return res.status(409).json({ ok: false, error: "Google Drive file ID is missing for this video.", deleteBootVersion: DELETE_BOOT_VERSION });
      if (fileId) await deleteDriveFile(fileId);

      const canonicalId = clean(video.id || video.publicId || video.videoId || requestedId, 500);
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
      if (recordKey !== canonicalId) {
        updates[`${CANONICAL_ROOT(user.uid)}/content/posts/${recordKey}`] = null;
        updates[`${CANONICAL_ROOT(user.uid)}/content/videos/${recordKey}`] = null;
        updates[`${CANONICAL_ROOT(user.uid)}/engagement/videos/${recordKey}`] = null;
        updates[`videoLikes/${recordKey}`] = null;
        updates[`videoComments/${recordKey}`] = null;
        updates[`videoSaves/${recordKey}`] = null;
      }
      await db.ref().update(updates);

      await db.ref(`${CANONICAL_ROOT(user.uid)}/stats/postsCount`).transaction((current) => Math.max(0, (Number(current) || 0) - 1));
      await db.ref(`${CANONICAL_ROOT(user.uid)}/stats/videosCount`).transaction((current) => Math.max(0, (Number(current) || 0) - 1));

      return res.json({ ok: true, deleted: true, videoId: canonicalId, driveDeleted: Boolean(fileId), matchedRecordKey: recordKey, match: found.match || "unknown", deleteBootVersion: DELETE_BOOT_VERSION });
    } catch (error) {
      console.error("Robust Firebase/Drive video delete failed:", error?.stack || error?.message || error);
      return res.status(Number(error?.status) || 500).json({ ok: false, error: clean(error?.message || "Could not delete video.", 300), deleteBootVersion: DELETE_BOOT_VERSION, code: error?.code || undefined });
    }
  });
};
