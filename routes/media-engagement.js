import express from 'express';

function safeText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

async function createNotification(db, targetUid, notification) {
  if (!targetUid || !db) return;
  const ref = db.ref(`users/${targetUid}/notifications`).push();
  await ref.set({ id: ref.key, read: false, createdAt: Date.now(), ...notification });
}

export function createMediaEngagementRouter({ db, requireUser }) {
  const router = express.Router();

  router.post('/media/:mediaId/like', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    const mediaId = safeText(req.params.mediaId, 120);
    const like = req.body?.like === true;
    if (!mediaId) return res.status(400).json({ ok: false, error: 'Media ID is required.' });
    try {
      const mediaRef = db.ref(`videos/${mediaId}`);
      const snapshot = await mediaRef.get();
      if (!snapshot.exists()) return res.status(404).json({ ok: false, error: 'Media not found.' });
      const media = snapshot.val() || {};
      const likeRef = db.ref(`videoLikes/${mediaId}/${user.uid}`);
      const wasLiked = Boolean((await likeRef.get()).val());
      await likeRef.set(like || null);
      const countRef = db.ref(`videos/${mediaId}/likes`);
      const result = await countRef.transaction((current) => {
        const value = Math.max(0, Number(current) || 0);
        if (like === wasLiked) return value;
        return like ? value + 1 : Math.max(0, value - 1);
      });
      if (like && !wasLiked && media.ownerUid && media.ownerUid !== user.uid) {
        const actor = (await db.ref(`users/${user.uid}`).get()).val() || {};
        await createNotification(db, media.ownerUid, {
          type: 'like', actorUid: user.uid, actorUsername: actor.username || '@user', mediaId,
          message: 'liked your video.'
        });
      }
      return res.json({ ok: true, liked: like, likes: Number(result.snapshot.val()) || 0 });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not update like.' });
    }
  });

  router.get('/media/:mediaId/engagement', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    const mediaId = safeText(req.params.mediaId, 120);
    try {
      const [mediaSnapshot, likeSnapshot, saveSnapshot] = await Promise.all([
        db.ref(`videos/${mediaId}`).get(),
        db.ref(`videoLikes/${mediaId}/${user.uid}`).get(),
        db.ref(`videoSaves/${mediaId}/${user.uid}`).get()
      ]);
      if (!mediaSnapshot.exists()) return res.status(404).json({ ok: false, error: 'Media not found.' });
      const media = mediaSnapshot.val() || {};
      return res.json({ ok: true, likes: Number(media.likes || 0), liked: Boolean(likeSnapshot.val()), saved: Boolean(saveSnapshot.val()) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not load engagement.' });
    }
  });

  router.post('/media/:mediaId/save', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    const mediaId = safeText(req.params.mediaId, 120);
    const save = req.body?.save === true;
    try {
      const mediaSnapshot = await db.ref(`videos/${mediaId}`).get();
      if (!mediaSnapshot.exists()) return res.status(404).json({ ok: false, error: 'Media not found.' });
      await db.ref(`videoSaves/${mediaId}/${user.uid}`).set(save || null);
      return res.json({ ok: true, saved: save });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not update save.' });
    }
  });

  router.post('/media/:mediaId/comments', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    const mediaId = safeText(req.params.mediaId, 120);
    const text = safeText(req.body?.text, 500);
    if (!text) return res.status(400).json({ ok: false, error: 'Comment cannot be empty.' });
    try {
      const mediaSnapshot = await db.ref(`videos/${mediaId}`).get();
      if (!mediaSnapshot.exists()) return res.status(404).json({ ok: false, error: 'Media not found.' });
      const media = mediaSnapshot.val() || {};
      const profileSnapshot = await db.ref(`users/${user.uid}`).get();
      const profile = profileSnapshot.val() || {};
      const ref = db.ref(`videoComments/${mediaId}`).push();
      const comment = { id: ref.key, mediaId, uid: user.uid, username: profile.username || `@${user.uid.slice(0, 8)}`, text, createdAt: Date.now() };
      await ref.set(comment);
      if (media.ownerUid && media.ownerUid !== user.uid) {
        await createNotification(db, media.ownerUid, {
          type: 'comment', actorUid: user.uid, actorUsername: comment.username, mediaId,
          message: 'commented on your video.'
        });
      }
      return res.status(201).json({ ok: true, comment });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not add comment.' });
    }
  });

  router.get('/media/:mediaId/comments', async (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    const mediaId = safeText(req.params.mediaId, 120);
    try {
      const snapshot = await db.ref(`videoComments/${mediaId}`).limitToLast(100).get();
      const comments = Object.values(snapshot.val() || {}).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      return res.json({ ok: true, comments });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not load comments.' });
    }
  });

  router.get('/notifications', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    try {
      const snapshot = await db.ref(`users/${user.uid}/notifications`).limitToLast(100).get();
      const notifications = Object.values(snapshot.val() || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      return res.json({ ok: true, notifications });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not load notifications.' });
    }
  });

  router.post('/notifications/:notificationId/read', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    const notificationId = safeText(req.params.notificationId, 120);
    try {
      const ref = db.ref(`users/${user.uid}/notifications/${notificationId}`);
      const snapshot = await ref.get();
      if (!snapshot.exists()) return res.status(404).json({ ok: false, error: 'Notification not found.' });
      await ref.update({ read: true });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not mark notification as read.' });
    }
  });

  return router;
}
