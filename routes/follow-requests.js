import express from "express";
import {
  respondToFollowRequest,
  toggleFollow,
  getFollowStatus,
} from "../services/social-follow.js";
import { syncCanonicalUser } from "../services/user-canonical.js";
import { canAccessMedia, isBlockedEitherWay } from "./social-block.js";

function entryList(snapshot) {
  const value = snapshot?.val?.() || {};
  return Object.values(value)
    .filter((item) => item && item.uid)
    .map((item) => ({
      uid: String(item.uid),
      userId: String(item.userId || item.username || ""),
      name: String(item.name || "Indo User"),
    }));
}

function clean(value, max = 160) {
  return String(value || "").trim().slice(0, max);
}

function publicProfile(uid, value = {}) {
  const profile = value?.profile || value || {};
  return {
    uid: String(uid),
    userId: String(profile.userId || profile.username || ""),
    username: String(profile.username || profile.userId || ""),
    name: String(profile.name || profile.displayName || "Indo User"),
    photoURL: String(profile.photoURL || profile.avatarUrl || ""),
  };
}

async function resolveTargetUid(db, rawTarget) {
  const value = String(rawTarget || "").trim();
  if (!value) return "";
  const direct = await db.ref(`users/${value}`).get();
  if (direct.exists()) return value;
  const normalized = value.toLowerCase().replace(/^@/, "");
  const encoded = normalized
    .replace(/\./g, "%2E")
    .replace(/#/g, "%23")
    .replace(/\$/g, "%24")
    .replace(/\//g, "%2F")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D");
  const claim = await db.ref(`usernames/${encoded}`).get();
  return String(claim.val()?.uid || "");
}

async function isFollower(db, targetUid, requesterUid) {
  const follower = await db
    .ref(`users/${targetUid}/social/followers/${requesterUid}`)
    .get();
  if (follower.exists()) return true;
  const legacyFollower = await db
    .ref(`users/${targetUid}/followers/${requesterUid}`)
    .get();
  return legacyFollower.exists();
}

export function createFollowRequestsRouter({
  db,
  requireUser,
}) {
  const router = express.Router();

  router.get(
    "/social/follow-requests",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
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
      } catch {
        return res.status(500).json({
          ok: false,
          error: "Could not load follow requests.",
        });
      }
    },
  );

  router.post(
    "/social/follow-requests/:requesterUid",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });
      const requesterUid = String(req.params.requesterUid || "").trim();
      const accept = req.body?.accept === true;
      if (!requesterUid)
        return res.status(400).json({
          ok: false,
          error: "Requester is required.",
        });
      try {
        const result = await respondToFollowRequest({
          db,
          ownerUid: user.uid,
          requesterUid,
          accept,
        });
        return res.json(result);
      } catch {
        return res.status(400).json({
          ok: false,
          error: "Could not respond to follow request.",
        });
      }
    },
  );

  router.post(
    "/social/follow",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });
      const targetUid = String(req.body?.targetUid || "").trim();
      const follow = req.body?.follow === true;
      if (!targetUid)
        return res.status(400).json({
          ok: false,
          error: "Target user is required.",
        });
      if (targetUid === user.uid)
        return res.status(400).json({
          ok: false,
          error: "You cannot follow yourself.",
        });
      try {
        const result = await toggleFollow({
          db,
          followerUid: user.uid,
          targetUid,
          follow,
        });
        return res.json({ ok: true, ...result });
      } catch {
        return res.status(400).json({
          ok: false,
          error: "Could not update follow status.",
        });
      }
    },
  );

  router.get(
    "/social/follow-status/:targetUid",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });
      const targetUid = String(req.params.targetUid || "").trim();
      if (!targetUid)
        return res.status(400).json({
          ok: false,
          error: "Target user is required.",
        });
      try {
        const result = await getFollowStatus({
          db,
          followerUid: user.uid,
          targetUid,
        });
        return res.json({ ok: true, ...result });
      } catch {
        return res.status(500).json({
          ok: false,
          error: "Could not load follow status.",
        });
      }
    },
  );

  router.get(
    "/social/profile/:targetUid",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });
      try {
        const targetUid = await resolveTargetUid(db, req.params.targetUid);
        if (!targetUid)
          return res.status(404).json({
            ok: false,
            error: "Profile not found.",
          });
        const canonical = await syncCanonicalUser({
          db,
          uid: targetUid,
          includeContent: true,
        });
        const privateAccount = canonical.settings.accountType === "private";
        const ownProfile = String(user.uid) === String(targetUid);
        const follower = ownProfile
          ? true
          : await isFollower(db, targetUid, user.uid);
        const canViewPrivateContent =
          !privateAccount || ownProfile || follower;

        const publicProfile = {
          uid: targetUid,
          username: canonical.profile.username || "",
          userId: canonical.profile.userId || canonical.profile.username || "",
          name:
            canonical.profile.name ||
            canonical.profile.displayName ||
            "Indo User",
          displayName:
            canonical.profile.displayName ||
            canonical.profile.name ||
            "Indo User",
          bio: canonical.profile.bio || "",
          photoURL:
            canonical.profile.photoURL || canonical.profile.avatarUrl || "",
          accountType: canonical.settings.accountType,
          isVerified: Boolean(
            canonical.profile.isVerified || canonical.verification.isVerified,
          ),
        };

        return res.json({
          ok: true,
          targetUid,
          profile: publicProfile,
          stats: canonical.stats,
          social: {
            followersCount: canonical.stats.followersCount,
            followingCount: canonical.stats.followingCount,
          },
          videos: canViewPrivateContent
            ? Object.values(canonical.content.videos)
            : [],
          stories: canViewPrivateContent
            ? Object.values(canonical.content.stories)
            : [],
          privateContentHidden: !canViewPrivateContent,
        });
      } catch {
        return res.status(500).json({
          ok: false,
          error: "Could not load profile.",
        });
      }
    },
  );

  async function listRelationship(req, res, relation) {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res.status(503).json({
        ok: false,
        error: "Firebase Admin is not configured on the backend.",
      });
    const rawTarget = String(req.params.targetUid || "").trim();
    if (!rawTarget)
      return res.status(400).json({
        ok: false,
        error: "Target user is required.",
      });
    try {
      const targetUid = await resolveTargetUid(db, rawTarget);
      if (!targetUid)
        return res.status(404).json({
          ok: false,
          error: "Profile not found.",
        });
      const canonical = await syncCanonicalUser({
        db,
        uid: targetUid,
        includeContent: false,
      });
      if (
        String(user.uid) !== targetUid &&
        canonical.settings.accountType === "private"
      ) {
        if (!(await isFollower(db, targetUid, user.uid)))
          return res.status(403).json({
            ok: false,
            error:
              "Follow this private account to view its followers/following.",
          });
      }
      const relationItems =
        relation === "followers"
          ? canonical.social.followers
          : canonical.social.following;
      const items = entryList({ val: () => relationItems });
      return res.json({
        ok: true,
        targetUid,
        relation,
        count: items.length,
        items,
      });
    } catch {
      return res.status(500).json({
        ok: false,
        error: `Could not load ${relation}.`,
      });
    }
  }

  router.get(
    "/social/followers/:targetUid",
    (req, res) => listRelationship(req, res, "followers"),
  );
  router.get(
    "/social/following/:targetUid",
    (req, res) => listRelationship(req, res, "following"),
  );

  // Authenticated users can see the likes list for any media they can view.
  router.get("/media/:mediaId/likes", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = clean(req.params.mediaId, 120);
    try {
      const mediaSnapshot = await db.ref(`videos/${mediaId}`).get();
      if (!mediaSnapshot.exists()) return res.status(404).json({ ok: false, error: "Media not found." });
      const media = mediaSnapshot.val() || {};
      if (!(await canAccessMedia({ db, requireUser, req, res, media }))) return;
      const snapshot = await db.ref(`videoLikes/${mediaId}`).get();
      const ids = Object.entries(snapshot.val() || {})
        .filter(([, value]) => Boolean(value))
        .map(([uid]) => String(uid))
        .slice(0, 500);
      const items = [];
      for (const uid of ids) {
        const profileSnapshot = await db.ref(`users/${uid}`).get();
        if (profileSnapshot.exists()) items.push(publicProfile(uid, profileSnapshot.val()));
      }
      return res.json({ ok: true, mediaId, count: items.length, items });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not load likes." });
    }
  });

  // A comment may be removed only by its author or by the video's owner.
  router.delete("/media/:mediaId/comments/:commentId", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const mediaId = clean(req.params.mediaId, 120);
    const commentId = clean(req.params.commentId, 160);
    try {
      const mediaSnapshot = await db.ref(`videos/${mediaId}`).get();
      if (!mediaSnapshot.exists()) return res.status(404).json({ ok: false, error: "Media not found." });
      const media = mediaSnapshot.val() || {};
      if (!(await canAccessMedia({ db, requireUser, req, res, media }))) return;
      const commentRef = db.ref(`videoComments/${mediaId}/${commentId}`);
      const commentSnapshot = await commentRef.get();
      if (!commentSnapshot.exists()) return res.status(404).json({ ok: false, error: "Comment not found." });
      const comment = commentSnapshot.val() || {};
      const isAuthor = String(comment.uid || "") === String(user.uid);
      const isOwner = String(media.ownerUid || "") === String(user.uid);
      if (!isAuthor && !isOwner)
        return res.status(403).json({ ok: false, error: "You can delete only your own comment or a comment on your video." });
      await commentRef.remove();
      if (media.ownerUid)
        await db.ref(`users/${media.ownerUid}/engagement/videos/${mediaId}/comments/${commentId}`).remove();
      return res.json({ ok: true, deleted: true, mediaId, commentId });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not delete comment." });
    }
  });

  // Saves are private: only the authenticated user's saved videos are returned.
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
        const mediaSnapshot = await db.ref(`videos/${mediaId}`).get();
        if (!mediaSnapshot.exists()) continue;
        const media = mediaSnapshot.val() || {};
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

  // Stories are available to authenticated users. Private-account stories are
  // visible only to the owner or accepted followers.
  router.get("/stories", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    try {
      const snapshot = await db.ref("stories").get();
      const now = Date.now();
      const items = [];
      for (const story of Object.values(snapshot.val() || {})) {
        if (!story || Number(story.expiresAt || 0) <= now) continue;
        const ownerUid = String(story.ownerUid || "");
        if (!ownerUid) continue;
        const ownerSnapshot = await db.ref(`users/${ownerUid}`).get();
        if (!ownerSnapshot.exists()) continue;
        const owner = ownerSnapshot.val() || {};
        if (
          await isBlockedEitherWay({
            db,
            requesterUid: user.uid,
            ownerUid,
          })
        ) continue;
        const accountType = String(owner.accountType || "public").toLowerCase();
        if (accountType === "private" && ownerUid !== user.uid) {
          if (!(await isFollower(db, ownerUid, user.uid))) continue;
        }
        items.push(story);
      }
      items.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      return res.json({ ok: true, stories: items.slice(0, 200) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not load stories." });
    }
  });

  return router;
}
