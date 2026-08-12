import express from 'express';
import { respondToFollowRequest } from '../services/social-follow.js';

function clean(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

async function canViewPrivateMedia({ db, requireUser, req, res, ownerUid }) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'Login required to view this private account.' });
    return false;
  }
  const requester = await requireUser(req, res);
  if (!requester) return false;
  if (requester.uid === ownerUid) return true;
  const follower = await db.ref(`users/${ownerUid}/followers/${requester.uid}`).get();
  return follower.exists();
}

export function createSocialBlockRouter({ db, requireUser }) {
  const router = express.Router();

  router.get('/social/blocked', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    try {
      const snapshot = await db.ref(`users/${user.uid}/blocked`).get();
      const users = Object.values(snapshot.val() || {}).sort((a, b) => String(a.username || '').localeCompare(String(b.username || '')));
      return res.json({ ok: true, users });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not load blocked users.' });
    }
  });

  router.post('/social/block', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    const targetUid = clean(req.body?.targetUid);
    const blocked = req.body?.blocked === true;
    if (!targetUid) return res.status(400).json({ ok: false, error: 'Target user is required.' });
    if (targetUid === user.uid) return res.status(400).json({ ok: false, error: 'You cannot block your own account.' });

    try {
      const targetSnapshot = await db.ref(`users/${targetUid}`).get();
      if (!targetSnapshot.exists()) return res.status(404).json({ ok: false, error: 'Target profile not found.' });

      const target = targetSnapshot.val() || {};
      const blockPath = `users/${user.uid}/blocked/${targetUid}`;
      const followingPath = `users/${user.uid}/following/${targetUid}`;
      const followerPath = `users/${targetUid}/followers/${user.uid}`;
      const payload = blocked ? {
        uid: targetUid,
        username: target.username || `@${targetUid.slice(0, 8)}`,
        name: target.name || 'Indo User',
        blockedAt: Date.now()
      } : null;

      await db.ref().update({
        [blockPath]: payload,
        [followingPath]: null,
        [followerPath]: null
      });
      return res.json({ ok: true, blocked, user: payload });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not update blocked user.' });
    }
  });

  router.get('/social/follow-requests', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    try {
      const [incomingSnapshot, outgoingSnapshot] = await Promise.all([
        db.ref(`users/${user.uid}/followRequests`).get(),
        db.ref(`users/${user.uid}/sentFollowRequests`).get()
      ]);
      return res.json({ ok: true, incoming: Object.values(incomingSnapshot.val() || {}), outgoing: Object.values(outgoingSnapshot.val() || {}) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not load follow requests.' });
    }
  });

  router.post('/social/follow-requests/:requesterUid', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    const requesterUid = clean(req.params.requesterUid);
    const accept = req.body?.accept === true;
    if (!requesterUid) return res.status(400).json({ ok: false, error: 'Requester is required.' });
    try {
      const result = await respondToFollowRequest({ db, ownerUid: user.uid, requesterUid, accept });
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || 'Could not respond to follow request.' });
    }
  });

  // This runs before the legacy /api/media/videos route in server.js.
  // Private-account media is visible only to the owner or approved followers.
  router.get('/media/videos', async (req, res, next) => {
    if (!db) return next();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const type = String(req.query.type || '').trim().toLowerCase();
    try {
      const snapshot = await db.ref('videos').orderByChild('createdAt').limitToLast(100).get();
      const allVideos = Object.values(snapshot.val() || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      const candidates = (type === 'video' || type === 'reel')
        ? allVideos.filter((item) => (item.mediaType || 'video') === type)
        : allVideos;

      const profileCache = new Map();
      const followerCache = new Map();
      const visible = [];

      for (const video of candidates) {
        const ownerUid = String(video.ownerUid || '');
        if (!ownerUid) continue;
        if (!profileCache.has(ownerUid)) profileCache.set(ownerUid, db.ref(`users/${ownerUid}`).get());
        const profile = (await profileCache.get(ownerUid)).val() || {};
        if ((profile.accountType || 'public') !== 'private') {
          visible.push(video);
          continue;
        }

        const header = req.headers.authorization || '';
        if (!header.startsWith('Bearer ')) continue;
        const requester = await requireUser(req, res);
        if (!requester) return;
        if (requester.uid === ownerUid) {
          visible.push(video);
          continue;
        }
        const key = `${ownerUid}:${requester.uid}`;
        if (!followerCache.has(key)) followerCache.set(key, db.ref(`users/${ownerUid}/followers/${requester.uid}`).get());
        if ((await followerCache.get(key)).exists()) visible.push(video);
      }

      return res.json({ ok: true, videos: visible.slice(0, limit) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not load videos.' });
    }
  });

  router.post('/media/videos/:videoId/view', async (req, res, next) => {
    if (!db) return next();
    const videoId = clean(req.params.videoId);
    if (!videoId) return res.status(400).json({ ok: false, error: 'Video ID is required.' });
    try {
      const videoRef = db.ref(`videos/${videoId}`);
      const snapshot = await videoRef.get();
      if (!snapshot.exists()) return res.status(404).json({ ok: false, error: 'Video not found.' });
      const video = snapshot.val() || {};
      const ownerSnapshot = await db.ref(`users/${video.ownerUid}`).get();
      const owner = ownerSnapshot.val() || {};
      if ((owner.accountType || 'public') === 'private') {
        const allowed = await canViewPrivateMedia({ db, requireUser, req, res, ownerUid: String(video.ownerUid || '') });
        if (!allowed) return;
      }
      const result = await videoRef.child('views').transaction((current) => (Number(current) || 0) + 1);
      return res.json({ ok: true, videoId, views: Number(result.snapshot.val()) || 0 });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not record video view.' });
    }
  });

  return router;
}
