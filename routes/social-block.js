import express from "express";
import { respondToFollowRequest } from "../services/social-follow.js";

function clean(value, max = 120) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

export async function getOptionalRequester(req, requireUser) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  try {
    return await requireUser(req, {
      status() {
        return this;
      },
      json() {
        return this;
      },
    });
  } catch {
    return null;
  }
}

export async function isBlockedEitherWay({ db, requesterUid, ownerUid }) {
  if (!requesterUid || !ownerUid || requesterUid === ownerUid) return false;
  const [requesterBlocked, ownerBlocked] = await Promise.all([
    db.ref(`users/${requesterUid}/blocked/${ownerUid}`).get(),
    db.ref(`users/${ownerUid}/blocked/${requesterUid}`).get(),
  ]);
  return requesterBlocked.exists() || ownerBlocked.exists();
}

export async function canViewPrivateMedia({
  db,
  requireUser,
  req,
  res,
  ownerUid,
}) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    res
      .status(401)
      .json({
        ok: false,
        error: "Login required to view this private account.",
      });
    return false;
  }
  const requester = await requireUser(req, res);
  if (!requester) return false;
  if (requester.uid === ownerUid) return true;
  if (await isBlockedEitherWay({ db, requesterUid: requester.uid, ownerUid })) {
    res.status(403).json({ ok: false, error: "This user is blocked." });
    return false;
  }
  const follower = await db
    .ref(`users/${ownerUid}/followers/${requester.uid}`)
    .get();
  if (!follower.exists()) {
    res
      .status(403)
      .json({
        ok: false,
        error: "Follow this private account to view its content.",
      });
    return false;
  }
  return true;
}

export async function canAccessMedia({ db, requireUser, req, res, media }) {
  const ownerUid = String(media?.ownerUid || "");
  if (!ownerUid) return false;
  const requester = await getOptionalRequester(req, requireUser);
  if (
    await isBlockedEitherWay({ db, requesterUid: requester?.uid, ownerUid })
  ) {
    res.status(403).json({ ok: false, error: "This user is blocked." });
    return false;
  }
  const ownerSnapshot = await db.ref(`users/${ownerUid}`).get();
  const owner = ownerSnapshot.val() || {};
  if ((owner.accountType || "public") !== "private") return true;
  return canViewPrivateMedia({ db, requireUser, req, res, ownerUid });
}

export function createSocialBlockRouter({ db, requireUser }) {
  const router = express.Router();

  router.get("/social/blocked", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res
        .status(503)
        .json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });
    try {
      const snapshot = await db.ref(`users/${user.uid}/blocked`).get();
      const users = Object.values(snapshot.val() || {}).sort((a, b) =>
        String(a.username || "").localeCompare(String(b.username || "")),
      );
      return res.json({ ok: true, users });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error: error.message || "Could not load blocked users.",
        });
    }
  });

  router.post("/social/block", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res
        .status(503)
        .json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });
    const targetUid = clean(req.body?.targetUid);
    const blocked = req.body?.blocked === true;
    if (!targetUid)
      return res
        .status(400)
        .json({ ok: false, error: "Target user is required." });
    if (targetUid === user.uid)
      return res
        .status(400)
        .json({ ok: false, error: "You cannot block your own account." });

    try {
      const targetSnapshot = await db.ref(`users/${targetUid}`).get();
      if (!targetSnapshot.exists())
        return res
          .status(404)
          .json({ ok: false, error: "Target profile not found." });

      const target = targetSnapshot.val() || {};
      const blockPath = `users/${user.uid}/blocked/${targetUid}`;
      const followingPath = `users/${user.uid}/following/${targetUid}`;
      const followerPath = `users/${targetUid}/followers/${user.uid}`;
      const payload = blocked
        ? {
            uid: targetUid,
            username: target.username || `@${targetUid.slice(0, 8)}`,
            name: target.name || "Indo User",
            blockedAt: Date.now(),
          }
        : null;

      await db.ref().update({
        [blockPath]: payload,
        [followingPath]: null,
        [followerPath]: null,
      });
      return res.json({ ok: true, blocked, user: payload });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error: error.message || "Could not update blocked user.",
        });
    }
  });

  router.get("/social/follow-requests", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res
        .status(503)
        .json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });
    try {
      const [incomingSnapshot, outgoingSnapshot] = await Promise.all([
        db.ref(`users/${user.uid}/followRequests`).get(),
        db.ref(`users/${user.uid}/sentFollowRequests`).get(),
      ]);
      return res.json({
        ok: true,
        incoming: Object.values(incomingSnapshot.val() || {}),
        outgoing: Object.values(outgoingSnapshot.val() || {}),
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error: error.message || "Could not load follow requests.",
        });
    }
  });

  router.post("/social/follow-requests/:requesterUid", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res
        .status(503)
        .json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });
    const requesterUid = clean(req.params.requesterUid);
    const accept = req.body?.accept === true;
    if (!requesterUid)
      return res
        .status(400)
        .json({ ok: false, error: "Requester is required." });
    try {
      const result = await respondToFollowRequest({
        db,
        ownerUid: user.uid,
        requesterUid,
        accept,
      });
      return res.json(result);
    } catch (error) {
      return res
        .status(400)
        .json({
          ok: false,
          error: error.message || "Could not respond to follow request.",
        });
    }
  });

  router.get("/stories", async (req, res, next) => {
    if (!db) return next();
    const requester = await getOptionalRequester(req, requireUser);
    if (!requester)
      return res
        .status(401)
        .json({ ok: false, error: "Authentication required." });
    try {
      const now = Date.now();
      const snapshot = await db
        .ref("stories")
        .orderByChild("expiresAt")
        .startAt(now)
        .get();
      const stories = Object.values(snapshot.val() || {});
      const profileCache = new Map();
      const followerCache = new Map();
      const visible = [];

      for (const story of stories) {
        const ownerUid = String(story.ownerUid || "");
        if (!ownerUid) continue;
        if (
          await isBlockedEitherWay({
            db,
            requesterUid: requester.uid,
            ownerUid,
          })
        )
          continue;
        if (ownerUid === requester.uid) {
          visible.push(story);
          continue;
        }
        if (!profileCache.has(ownerUid))
          profileCache.set(ownerUid, db.ref(`users/${ownerUid}`).get());
        const profile = (await profileCache.get(ownerUid)).val() || {};
        if ((profile.accountType || "public") !== "private") {
          visible.push(story);
          continue;
        }
        const key = `${ownerUid}:${requester.uid}`;
        if (!followerCache.has(key))
          followerCache.set(
            key,
            db.ref(`users/${ownerUid}/followers/${requester.uid}`).get(),
          );
        if ((await followerCache.get(key)).exists()) visible.push(story);
      }

      visible.sort(
        (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0),
      );
      return res.json({ ok: true, stories: visible });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not load stories." });
    }
  });

  router.get("/media/videos", async (req, res, next) => {
    if (!db) return next();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const type = String(req.query.type || "")
      .trim()
      .toLowerCase();
    try {
      const requester = (req.headers.authorization || "").startsWith("Bearer ")
        ? await getOptionalRequester(req, requireUser)
        : null;
      const snapshot = await db
        .ref("videos")
        .orderByChild("createdAt")
        .limitToLast(100)
        .get();
      const allVideos = Object.values(snapshot.val() || {}).sort(
        (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0),
      );
      const candidates =
        type === "video" || type === "reel"
          ? allVideos.filter((item) => (item.mediaType || "video") === type)
          : allVideos;
      const profileCache = new Map();
      const followerCache = new Map();
      const visible = [];

      for (const video of candidates) {
        const ownerUid = String(video.ownerUid || "");
        if (!ownerUid) continue;
        if (
          await isBlockedEitherWay({
            db,
            requesterUid: requester?.uid,
            ownerUid,
          })
        )
          continue;
        if (!profileCache.has(ownerUid))
          profileCache.set(ownerUid, db.ref(`users/${ownerUid}`).get());
        const profile = (await profileCache.get(ownerUid)).val() || {};
        if ((profile.accountType || "public") !== "private") {
          visible.push(video);
          continue;
        }
        if (!requester) continue;
        if (requester.uid === ownerUid) {
          visible.push(video);
          continue;
        }
        const key = `${ownerUid}:${requester.uid}`;
        if (!followerCache.has(key))
          followerCache.set(
            key,
            db.ref(`users/${ownerUid}/followers/${requester.uid}`).get(),
          );
        if ((await followerCache.get(key)).exists()) visible.push(video);
      }
      return res.json({ ok: true, videos: visible.slice(0, limit) });
    } catch (error) {
      return res
        .status(500)
        .json({ ok: false, error: error.message || "Could not load videos." });
    }
  });

  router.post("/media/videos/:videoId/view", async (req, res, next) => {
    if (!db) return next();
    const videoId = clean(req.params.videoId);
    if (!videoId)
      return res
        .status(400)
        .json({ ok: false, error: "Video ID is required." });
    try {
      const videoRef = db.ref(`videos/${videoId}`);
      const snapshot = await videoRef.get();
      if (!snapshot.exists())
        return res.status(404).json({ ok: false, error: "Video not found." });
      const video = snapshot.val() || {};
      if (!(await canAccessMedia({ db, requireUser, req, res, media: video })))
        return;
      const result = await videoRef
        .child("views")
        .transaction((current) => (Number(current) || 0) + 1);
      return res.json({
        ok: true,
        videoId,
        views: Number(result.snapshot.val()) || 0,
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error: error.message || "Could not record video view.",
        });
    }
  });

  return router;
}
