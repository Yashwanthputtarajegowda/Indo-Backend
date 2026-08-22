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
  const app = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL: DATABASE_URL,
  }, "video-delete-boot");
  return getDatabaseWithUrl(DATABASE_URL, app);
}

function clean(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

function ownerUidFromVideo(video = {}) {
  return clean(
    video.ownerUid ||
    video.uid ||
    video.userId ||
    video.creatorUid ||
    video.owner?.uid ||
    video.user?.uid ||
    "",
    160,
  );
}

function driveFileIdFromVideo(video = {}) {
  return clean(
    video?.googleDrive?.fileId ||
    video?.drive?.fileId ||
    video?.storage?.fileId ||
    video?.googleDriveFileId ||
    "",
    300,
  );
}

function candidateScore(video = {}, requestedId = "") {
  const id = clean(requestedId);
  let score = 0;
  if (clean(video.id) === id) score += 100;
  if (clean(video.publicId) === id) score += 90;
  if (clean(video.videoId) === id) score += 80;
  if (clean(video.mediaId) === id) score += 70;
  if (clean(video.recordKey) === id) score += 60;
  return score;
}

async function findVideo(db, uid, requestedId) {
  const id = clean(requestedId, 200);
  if (!id) return null;
  const owner = clean(uid, 160);

  // 1) Normal Firebase push-key lookup.
  const direct = await db.ref(`videos/${id}`).get();
  if (direct.exists()) {
    const video = direct.val() || {};
    const videoOwner = ownerUidFromVideo(video);
    if (!videoOwner || videoOwner === owner) return { key: id, video, match: "record-key" };
  }

  // 2) Exact logical id lookup. This handles older records whose Firebase
  // push key differs from the video's own id field.
  const allSnapshot = await db.ref("videos").get();
  const all = allSnapshot.val() || {};
  let best = null;

  for (const [key, rawVideo] of Object.entries(all)) {
    if (!rawVideo || typeof rawVideo !== "object") continue;
    const videoOwner = ownerUidFromVideo(rawVideo);
    if (videoOwner && videoOwner !== owner) continue;

    const score = candidateScore(rawVideo, id);
    const keyMatch = clean(key) === id ? 50 : 0;
    if (score || keyMatch) {
      const total = score + keyMatch;
      if (!best || total > best.score) best = { key, video: rawVideo, score: total, match: "logical-id" };
    }
  }
  if (best) return best;

  // 3) Canonical content fallback. Some migrated videos can exist only in
  // the canonical user's content tree while the legacy /videos entry is gone.
  const [canonicalVideo, canonicalPost] = await Promise.all([
    db.ref(`${CANONICAL_ROOT(owner)}/content/videos/${id}`).get(),
    db.ref(`${CANONICAL_ROOT(owner)}/content/posts/${id}`).get(),
  ]);
  const canonical = canonicalVideo.exists()
    ? canonicalVideo.val()
    : canonicalPost.exists()
      ? canonicalPost.val()
      : null;

  if (canonical && typeof canonical === "object") {
    const canonicalId = clean(canonical.id || canonical.publicId || canonical.videoId || id, 200);
    for (const [key, rawVideo] of Object.entries(all)) {
      if (!rawVideo || typeof rawVideo !== "object") continue;
      const videoOwner = ownerUidFromVideo(rawVideo);
      if (videoOwner && videoOwner !== owner) continue;
      const logical = clean(rawVideo.id || rawVideo.publicId || rawVideo.videoId || "", 200);
      if (logical && logical === canonicalId) return { key, video: rawVideo, match: "canonical-linked" };
    }
    return { key: canonicalId, video: { ...canonical, id: canonicalId, ownerUid: owner }, canonicalOnly: true, match: "canonical-only" };
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

    const requestedId = clean(req.params.videoId, 200);
    if (!requestedId) return res.status(400).json({ ok: false, error: "Video ID is required." });

    try {
      const found = await findVideo(db, user.uid, requestedId);
      if (!found) return res.status(404).json({ ok: false, error: "Video not found." });

      const { key: recordKey, video } = found;
      const ownerUid = ownerUidFromVideo(video) || String(user.uid || "");
      if (ownerUid !== String(user.uid || "")) {
        return res.status(403).json({ ok: false, error: "You can delete only your own video." });
      }

      const provider = clean(video.storage?.provider, 80).toLowerCase();
      const fileId = driveFileIdFromVideo(video);
      if (provider === "google-drive" && !fileId) {
        return res.status(409).json({ ok: false, error: "Google Drive file ID is missing for this video." });
      }

      // Delete the storage object first. Already-missing Drive files are
      // intentionally treated as successful cleanup by deleteDriveFile().
      if (fileId) await deleteDriveFile(fileId);

      const canonicalId = clean(video.id || video.publicId || video.videoId || requestedId, 200);
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

      return res.json({
        ok: true,
        videoId: canonicalId,
        deleted: true,
        alreadyDeleted: false,
        driveDeleted: Boolean(fileId),
        matchedRecordKey: recordKey,
        match: found.match || "unknown",
      });
    } catch (error) {
      console.error("Robust video delete failed:", error?.stack || error?.message || error);
      return res.status(Number(error?.status) || 500).json({
        ok: false,
        error: clean(error?.message || "Could not delete video.", 300),
      });
    }
  });
};
