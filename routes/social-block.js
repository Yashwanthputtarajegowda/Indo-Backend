import express from 'express';

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

      const updates = {
        [blockPath]: payload,
        [followingPath]: null,
        [followerPath]: null
      };
      await db.ref().update(updates);
      return res.json({ ok: true, blocked, user: payload });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not update blocked user.' });
    }
  });

  return router;
}
