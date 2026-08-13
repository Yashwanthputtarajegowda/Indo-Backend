import express from "express";
import { respondToFollowRequest, toggleFollow, getFollowStatus } from "../services/social-follow.js";
import { syncCanonicalUser } from "../services/user-canonical.js";

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

export function createFollowRequestsRouter({ db, requireUser }) {
  const router = express.Router();

  router.get("/social/follow-requests", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Firebase Admin is not configured on the backend." });
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
      return res.status(500).json({ ok: false, error: error.message || "Could not load follow requests." });
    }
  });

  router.post("/social/follow-requests/:requesterUid", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Firebase Admin is not configured on the backend." });
    const requesterUid = String(req.params.requesterUid || "").trim();
    const accept = req.body?.accept === true;
    if (!requesterUid) return res.status(400).json({ ok: false, error: "Requester is required." });
    try {
      const result = await respondToFollowRequest({ db, ownerUid: user.uid, requesterUid, accept });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || "Could not respond to follow request." });
    }
  });

  router.post("/social/follow", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Firebase Admin is not configured on the backend." });
    const targetUid = String(req.body?.targetUid || "").trim();
    const follow = req.body?.follow === true;
    if (!targetUid) return res.status(400).json({ ok: false, error: "Target user is required." });
    try {
      const result = await toggleFollow({ db, followerUid: user.uid, targetUid, follow });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || "Could not update follow status." });
    }
  });

  router.get("/social/follow-status/:targetUid", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Firebase Admin is not configured on the backend." });
    const targetUid = String(req.params.targetUid || "").trim();
    try {
      const result = await getFollowStatus({ db, followerUid: user.uid, targetUid });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not load follow status." });
    }
  });

  router.get("/social/profile/:targetUid", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Firebase Admin is not configured on the backend." });
    try {
      const targetUid = await resolveTargetUid(db, req.params.targetUid);
      if (!targetUid) return res.status(404).json({ ok: false, error: "Profile not found." });
      const canonical = await syncCanonicalUser({ db, uid: targetUid, includeContent: true });
      const publicProfile = {
        ...canonical.profile,
        accountType: canonical.settings.accountType,
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
        videos: Object.values(canonical.content.videos),
        stories: Object.values(canonical.content.stories),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || "Could not load profile." });
    }
  });

  async function listRelationship(req, res, relation) {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Firebase Admin is not configured on the backend." });
    const rawTarget = String(req.params.targetUid || "").trim();
    if (!rawTarget) return res.status(400).json({ ok: false, error: "Target user is required." });
    try {
      const targetUid = await resolveTargetUid(db, rawTarget);
      if (!targetUid) return res.status(404).json({ ok: false, error: "Profile not found." });
      const canonical = await syncCanonicalUser({ db, uid: targetUid, includeContent: false });
      if (String(user.uid) !== targetUid && canonical.settings.accountType === "private") {
        const follower = await db.ref(`users/${targetUid}/social/followers/${user.uid}`).get();
        const legacyFollower = follower.exists()
          ? follower
          : await db.ref(`users/${targetUid}/followers/${user.uid}`).get();
        if (!legacyFollower.exists()) return res.status(403).json({ ok: false, error: "Follow this private account to view its followers/following." });
      }
      const relationItems = relation === "followers" ? canonical.social.followers : canonical.social.following;
      const items = entryList({ val: () => relationItems });
      return res.json({ ok: true, targetUid, relation, count: items.length, items });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || `Could not load ${relation}.` });
    }
  }

  router.get("/social/followers/:targetUid", (req, res) => listRelationship(req, res, "followers"));
  router.get("/social/following/:targetUid", (req, res) => listRelationship(req, res, "following"));

  return router;
}
