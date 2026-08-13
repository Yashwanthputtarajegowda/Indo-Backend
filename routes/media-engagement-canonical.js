import express from "express";
import { createNotification } from "../services/notifications.js";
import { canAccessMedia } from "./social-block.js";
import { setCanonicalVideoEngagement, saveCanonicalComment } from "../services/canonical-content.js";

function safeText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

export function createCanonicalMediaEngagementRouter({ db, requireUser }) {
  const router = express.Router();

  async function loadMedia(req, res, mediaId) {
    const snapshot = await db.ref(`videos/${mediaId}`).get();
    if (!snapshot.exists()) {
      res.status(404).json({ ok: false, error: "Media not found." });
      return null;
    }
    const media = snapshot.val() || {};
    if (!(await canAccessMedia({ db, requireUser, req, res, media }))) return null;
    return media;
  }

  router.post("/media/:mediaId/like", async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = safeText(req.params.mediaId, 120); const like = req.body?.like === true;
    try {
      const media = await loadMedia(req, res, mediaId); if (!media) return;
      const likeRef = db.ref(`videoLikes/${mediaId}/${user.uid}`);
      const wasLiked = Boolean((await likeRef.get()).val());
      await likeRef.set(like || null);
      const result = await db.ref(`videos/${mediaId}/likes`).transaction((current) => {
        const value = Math.max(0, Number(current) || 0);
        if (like === wasLiked) return value;
        return like ? value + 1 : Math.max(0, value - 1);
      });
      const likes = Number(result.snapshot.val()) || 0;
      if (media.ownerUid) await setCanonicalVideoEngagement({ db, ownerUid: media.ownerUid, mediaId, kind: "like", actorUid: user.uid, value: like, count: likes });
      if (like && !wasLiked && media.ownerUid && media.ownerUid !== user.uid) {
        const actor = (await db.ref(`users/${user.uid}`).get()).val() || {};
        await createNotification({ db, recipientUid: media.ownerUid, type: "like", actorUid: user.uid, actorName: actor.profile?.name || actor.name || "Indo User", actorUserId: actor.profile?.username || actor.username || "", text: "liked your video", targetId: mediaId });
      }
      return res.json({ ok: true, liked: like, likes });
    } catch (error) { return res.status(500).json({ ok: false, error: error.message || "Could not update like." }); }
  });

  router.get("/media/:mediaId/engagement", async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = safeText(req.params.mediaId, 120);
    try {
      const media = await loadMedia(req, res, mediaId); if (!media) return;
      const [likeSnapshot, saveSnapshot, canonicalLike, canonicalSave] = await Promise.all([
        db.ref(`videoLikes/${mediaId}/${user.uid}`).get(),
        db.ref(`videoSaves/${mediaId}/${user.uid}`).get(),
        media.ownerUid ? db.ref(`users/${media.ownerUid}/engagement/videos/${mediaId}/likes/${user.uid}`).get() : null,
        media.ownerUid ? db.ref(`users/${media.ownerUid}/engagement/videos/${mediaId}/saves/${user.uid}`).get() : null,
      ]);
      return res.json({ ok: true, likes: Number(media.likes || 0), liked: Boolean(canonicalLike?.val?.() ?? likeSnapshot.val()), saved: Boolean(canonicalSave?.val?.() ?? saveSnapshot.val()) });
    } catch (error) { return res.status(500).json({ ok: false, error: error.message || "Could not load engagement." }); }
  });

  router.post("/media/:mediaId/save", async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = safeText(req.params.mediaId, 120); const save = req.body?.save === true;
    try {
      const media = await loadMedia(req, res, mediaId); if (!media) return;
      await db.ref(`videoSaves/${mediaId}/${user.uid}`).set(save || null);
      if (media.ownerUid) await setCanonicalVideoEngagement({ db, ownerUid: media.ownerUid, mediaId, kind: "save", actorUid: user.uid, value: save });
      return res.json({ ok: true, saved: save });
    } catch (error) { return res.status(500).json({ ok: false, error: error.message || "Could not update save." }); }
  });

  router.post("/media/:mediaId/comments", async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = safeText(req.params.mediaId, 120); const text = safeText(req.body?.text, 500);
    if (!text) return res.status(400).json({ ok: false, error: "Comment cannot be empty." });
    try {
      const media = await loadMedia(req, res, mediaId); if (!media) return;
      const profile = (await db.ref(`users/${user.uid}`).get()).val() || {};
      const ref = db.ref(`videoComments/${mediaId}`).push();
      const comment = { id: ref.key, mediaId, uid: user.uid, username: profile.profile?.username || profile.username || `@${user.uid.slice(0, 8)}`, text, createdAt: Date.now() };
      await ref.set(comment);
      if (media.ownerUid) await saveCanonicalComment({ db, ownerUid: media.ownerUid, mediaId, comment });
      if (media.ownerUid && media.ownerUid !== user.uid) await createNotification({ db, recipientUid: media.ownerUid, type: "comment", actorUid: user.uid, actorName: profile.profile?.name || profile.name || "Indo User", actorUserId: comment.username, text: "commented on your video", targetId: mediaId });
      return res.status(201).json({ ok: true, comment });
    } catch (error) { return res.status(500).json({ ok: false, error: error.message || "Could not add comment." }); }
  });

  router.get("/media/:mediaId/comments", async (req, res) => {
    const user = await requireUser(req, res); if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = safeText(req.params.mediaId, 120);
    try {
      const media = await loadMedia(req, res, mediaId); if (!media) return;
      const canonicalSnapshot = media.ownerUid ? await db.ref(`users/${media.ownerUid}/engagement/videos/${mediaId}/comments`).limitToLast(100).get() : null;
      const snapshot = canonicalSnapshot?.exists() ? canonicalSnapshot : await db.ref(`videoComments/${mediaId}`).limitToLast(100).get();
      const comments = Object.values(snapshot.val() || {}).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      return res.json({ ok: true, comments });
    } catch (error) { return res.status(500).json({ ok: false, error: error.message || "Could not load comments." }); }
  });

  return router;
}
