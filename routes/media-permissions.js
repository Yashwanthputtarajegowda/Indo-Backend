import express from "express";
import { canAccessMedia } from "./social-block.js";

function clean(value, max = 160) {
  return String(value || "").trim().slice(0, max);
}

function profilePublic(uid, value = {}) {
  const profile = value?.profile || value || {};
  return {
    uid: String(uid),
    userId: String(profile.userId || profile.username || ""),
    username: String(profile.username || profile.userId || ""),
    name: String(profile.name || profile.displayName || "Indo User"),
    photoURL: String(profile.photoURL || profile.avatarUrl || ""),
  };
}

async function loadMedia(db, mediaId) {
  const snapshot = await db.ref(`videos/${mediaId}`).get();
  return snapshot.exists() ? snapshot.val() || {} : null;
}

export function createMediaPermissionsRouter({ db, requireUser }) {
  const router = express.Router();

  // Anyone who can view the video can view its authenticated likes list.
  router.get("/media/:mediaId/likes", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = clean(req.params.mediaId, 120);
    if (!mediaId) return res.status(400).json({ ok: false, error: "Media ID is required." });
    try {
      const media = await loadMedia(db, mediaId);
      if (!media) return res.status(404).json({ ok: false, error: "Media not found." });
      if (!(await canAccessMedia({ db, requireUser, req, res, media }))) return;
      const snapshot = await db.ref(`videoLikes/${mediaId}`).get();
      const ids = Object.entries(snapshot.val() || {})
        .filter(([, value]) => Boolean(value))
        .map(([uid]) => String(uid));
      const items = [];
      for (const uid of ids.slice(0, 500)) {
        const profileSnapshot = await db.ref(`users/${uid}`).get();
        if (profileSnapshot.exists()) items.push(profilePublic(uid, profileSnapshot.val()));
      }
      return res.json({ ok: true, mediaId, count: items.length, items });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not load likes." });
    }
  });

  // A comment can be deleted by its author or by the owner of the video.
  router.delete("/media/:mediaId/comments/:commentId", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = clean(req.params.mediaId, 120);
    const commentId = clean(req.params.commentId, 160);
    if (!mediaId || !commentId) return res.status(400).json({ ok: false, error: "Media and comment are required." });
    try {
      const media = await loadMedia(db, mediaId);
      if (!media) return res.status(404).json({ ok: false, error: "Media not found." });
      if (!(await canAccessMedia({ db, requireUser, req, res, media }))) return;

      const commentRef = db.ref(`videoComments/${mediaId}/${commentId}`);
      const commentSnapshot = await commentRef.get();
      if (!commentSnapshot.exists()) return res.status(404).json({ ok: false, error: "Comment not found." });
      const comment = commentSnapshot.val() || {};
      const isAuthor = String(comment.uid || "") === String(user.uid);
      const isOwner = String(media.ownerUid || "") === String(user.uid);
      if (!isAuthor && !isOwner) return res.status(403).json({ ok: false, error: "You can delete only your own comment or a comment on your video." });

      await commentRef.remove();
      if (media.ownerUid) {
        await db.ref(`users/${media.ownerUid}/engagement/videos/${mediaId}/comments/${commentId}`).remove();
      }
      return res.json({ ok: true, deleted: true, mediaId, commentId });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not delete comment." });
    }
  });

  // Saved videos are private to the authenticated user.
  router.get("/media/saved", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    try {
      const savesSnapshot = await db.ref("videoSaves").get();
      const savedIds = [];
      for (const [mediaId, value] of Object.entries(savesSnapshot.val() || {})) {
        if (value && value[user.uid]) savedIds.push(String(mediaId));
      }

      const videos = [];
      for (const mediaId of savedIds.slice(0, 200)) {
        const media = await loadMedia(db, mediaId);
        if (!media) continue;
        if (!(await canAccessMedia({ db, requireUser, req, res, media }))) {
          if (res.headersSent) return;
          continue;
        }
        videos.push(media);
      }
      return res.json({ ok: true, count: videos.length, videos });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not load saved videos." });
    }
  });

  return router;
}
