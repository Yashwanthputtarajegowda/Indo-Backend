import express from 'express';
import { respondToFollowRequest } from '../services/social-follow.js';

function clean(value, max = 120) {
  return String(value || '').trim().slice(0, max);
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

  return router;
}
