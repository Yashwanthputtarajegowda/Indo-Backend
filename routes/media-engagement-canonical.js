import express from "express";
import { createNotification } from "../services/notifications.js";
import { canAccessMedia } from "./social-block.js";
import {
  setCanonicalVideoEngagement,
  saveCanonicalComment,
  updateCanonicalVideoViews,
} from "../services/canonical-content.js";

function safeText(value, max = 500) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function normalizePrivacy(value) {
  const normalized = String(value || "public")
    .trim()
    .toLowerCase();
  return ["public", "followers", "private"].includes(normalized) ? normalized : "public";
}

function normalizeTags(value) {
  if (Array.isArray(value))
    return value
      .map((tag) =>
        String(tag || "")
          .trim()
          .replace(/^#/, ""),
      )
      .filter(Boolean)
      .slice(0, 20);
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 20);
}

function countTruthy(value) {
  return Object.values(value || {}).filter(Boolean).length;
}

export function createCanonicalMediaEngagementRouter({ db, requireUser }) {
  const router = express.Router();

  router.post("/media/videos", (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = async (payload) => {
      try {
        const videoId = String(payload?.video?.id || "").trim();
        if (db && payload?.ok && videoId) {
          const body = req.body || {};
          const metadata = {
            description: safeText(body.description ?? body.caption, 500),
            caption: safeText(body.description ?? body.caption, 500),
            privacy: normalizePrivacy(body.privacy),
            allowComments: body.allowComments !== false,
            allowDuet: body.allowDuet !== false,
            category: safeText(body.category, 60),
            tags: normalizeTags(body.tags),
            location: safeText(body.location, 120),
            updatedAt: Date.now(),
          };
          await db.ref(`videos/${videoId}`).update(metadata);
          if (payload.video && typeof payload.video === "object")
            payload.video = { ...payload.video, ...metadata };
        }
      } catch (error) {
        console.warn("Video metadata persistence failed:", error?.message || error);
      }
      return originalJson(payload);
    };
    next();
  });

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

  async function handleUniqueView(req, res, mediaId) {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    try {
      const media = await loadMedia(req, res, mediaId);
      if (!media) return;
      let firstViewForUser = false;
      const result = await db.ref(`videoViews/${mediaId}`).transaction((current) => {
        const next = current && typeof current === "object" ? { ...current } : {};
        const uid = String(user.uid);
        firstViewForUser = !Boolean(next[uid]);
        next[uid] = true;
        return next;
      });
      const users = result.snapshot.val() || {};
      const views = Math.max(Number(media.views || 0), countTruthy(users));
      await db.ref(`videos/${mediaId}/views`).set(views);
      if (media.ownerUid)
        await updateCanonicalVideoViews({
          db,
          uid: media.ownerUid,
          videoId: mediaId,
          views,
        });
      return res.json({
        ok: true,
        videoId: mediaId,
        views,
        counted: firstViewForUser,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not record video view.",
      });
    }
  }

  // One authenticated user gets at most one counted view for a media item.
  // Both routes are kept so older and newer frontend surfaces share the same rule.
  router.post("/media/:mediaId/view", (req, res) =>
    handleUniqueView(req, res, safeText(req.params.mediaId, 120)),
  );
  router.post("/media/videos/:videoId/view", (req, res) =>
    handleUniqueView(req, res, safeText(req.params.videoId, 120)),
  );

  router.post("/media/:mediaId/like", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = safeText(req.params.mediaId, 120);
    const like = req.body?.like === true;
    try {
      const media = await loadMedia(req, res, mediaId);
      if (!media) return;
      let wasLiked = false;
      const likeState = await db.ref(`videoLikes/${mediaId}`).transaction((current) => {
        const next = current && typeof current === "object" ? { ...current } : {};
        const uid = String(user.uid);
        wasLiked = Boolean(next[uid]);
        if (like) next[uid] = true;
        else delete next[uid];
        return next;
      });
      const likeUsers = likeState.snapshot.val() || {};
      const likes = countTruthy(likeUsers);
      await db.ref(`videos/${mediaId}/likes`).set(likes);
      if (media.ownerUid)
        await setCanonicalVideoEngagement({
          db,
          ownerUid: media.ownerUid,
          mediaId,
          kind: "like",
          actorUid: user.uid,
          value: like,
          count: likes,
        });
      if (like && !wasLiked && media.ownerUid && media.ownerUid !== user.uid) {
        const actor = (await db.ref(`users/${user.uid}`).get()).val() || {};
        await createNotification({
          db,
          recipientUid: media.ownerUid,
          type: "like",
          actorUid: user.uid,
          actorName: actor.profile?.name || actor.name || "Indo User",
          actorUserId: actor.profile?.username || actor.username || "",
          text: "liked your video",
          targetId: mediaId,
        });
      }
      return res.json({
        ok: true,
        liked: like,
        likes,
        changed: wasLiked !== like,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not update like." });
    }
  });

  router.get("/media/:mediaId/engagement", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = safeText(req.params.mediaId, 120);
    try {
      const media = await loadMedia(req, res, mediaId);
      if (!media) return;
      const [likeSnapshot, saveSnapshot, viewSnapshot, canonicalLike, canonicalSave] =
        await Promise.all([
          db.ref(`videoLikes/${mediaId}/${user.uid}`).get(),
          db.ref(`videoSaves/${mediaId}/${user.uid}`).get(),
          db.ref(`videoViews/${mediaId}/${user.uid}`).get(),
          media.ownerUid
            ? db.ref(`users/${media.ownerUid}/engagement/videos/${mediaId}/likes/${user.uid}`).get()
            : null,
          media.ownerUid
            ? db.ref(`users/${media.ownerUid}/engagement/videos/${mediaId}/saves/${user.uid}`).get()
            : null,
        ]);
      return res.json({
        ok: true,
        likes: Number(media.likes || 0),
        liked: Boolean(canonicalLike?.val?.() ?? likeSnapshot.val()),
        saved: Boolean(canonicalSave?.val?.() ?? saveSnapshot.val()),
        viewed: Boolean(viewSnapshot.val()),
        views: Number(media.views || 0),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not load engagement.",
      });
    }
  });

  router.post("/media/:mediaId/save", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = safeText(req.params.mediaId, 120);
    const save = req.body?.save === true;
    try {
      const media = await loadMedia(req, res, mediaId);
      if (!media) return;
      await db.ref(`videoSaves/${mediaId}/${user.uid}`).set(save || null);
      if (media.ownerUid)
        await setCanonicalVideoEngagement({
          db,
          ownerUid: media.ownerUid,
          mediaId,
          kind: "save",
          actorUid: user.uid,
          value: save,
        });
      return res.json({ ok: true, saved: save });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not update save." });
    }
  });

  router.post("/media/:mediaId/comments", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = safeText(req.params.mediaId, 120);
    const text = safeText(req.body?.text, 500);
    if (!text) return res.status(400).json({ ok: false, error: "Comment cannot be empty." });
    try {
      const media = await loadMedia(req, res, mediaId);
      if (!media) return;
      if (media.allowComments === false)
        return res.status(403).json({ ok: false, error: "Comments are disabled for this video." });
      const profile = (await db.ref(`users/${user.uid}`).get()).val() || {};
      const ref = db.ref(`videoComments/${mediaId}`).push();
      const comment = {
        id: ref.key,
        mediaId,
        uid: user.uid,
        username: profile.profile?.username || profile.username || `@${user.uid.slice(0, 8)}`,
        text,
        createdAt: Date.now(),
      };
      await ref.set(comment);
      if (media.ownerUid)
        await saveCanonicalComment({
          db,
          ownerUid: media.ownerUid,
          mediaId,
          comment,
        });
      if (media.ownerUid && media.ownerUid !== user.uid)
        await createNotification({
          db,
          recipientUid: media.ownerUid,
          type: "comment",
          actorUid: user.uid,
          actorName: profile.profile?.name || profile.name || "Indo User",
          actorUserId: comment.username,
          text: "commented on your video",
          targetId: mediaId,
        });
      return res.status(201).json({ ok: true, comment });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not add comment." });
    }
  });

  router.get("/media/:mediaId/comments", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = safeText(req.params.mediaId, 120);
    try {
      const media = await loadMedia(req, res, mediaId);
      if (!media) return;
      const canonicalSnapshot = media.ownerUid
        ? await db
            .ref(`users/${media.ownerUid}/engagement/videos/${mediaId}/comments`)
            .limitToLast(100)
            .get()
        : null;
      const snapshot = canonicalSnapshot?.exists()
        ? canonicalSnapshot
        : await db.ref(`videoComments/${mediaId}`).limitToLast(100).get();
      const comments = Object.values(snapshot.val() || {}).sort(
        (a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0),
      );
      return res.json({ ok: true, comments });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not load comments.",
      });
    }
  });

  return router;
}
