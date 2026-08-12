import express from 'express';

function publicProfile(profile = {}) {
  return {
    uid: profile.uid || '',
    userId: profile.username || '',
    name: profile.name || 'Indo User',
    bio: profile.bio || '',
    accountType: profile.accountType === 'private' ? 'private' : 'public',
    followersCount: Number(profile.followersCount || 0),
    followingCount: Number(profile.followingCount || 0),
    postsCount: Number(profile.postsCount || 0)
  };
}

export function createAccountContactRouter({ db, auth, requireUser }) {
  const router = express.Router();

  router.patch('/account/contact', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });

    const mobile = String(req.body?.mobile || '').trim();
    const email = String(req.body?.email || user.email || '').trim().toLowerCase();

    if (!mobile) return res.status(400).json({ ok: false, error: 'Mobile number is required.' });
    if (!/^\+?[0-9 ()-]{7,20}$/.test(mobile)) {
      return res.status(400).json({ ok: false, error: 'Invalid mobile number.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email address.' });
    }

    try {
      const userRef = db.ref(`users/${user.uid}`);
      const snapshot = await userRef.get();
      if (!snapshot.exists()) return res.status(404).json({ ok: false, error: 'Profile not found.' });

      await userRef.update({ mobile, email, contactUpdatedAt: Date.now() });
      return res.json({ ok: true, mobile, email });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not save contact details.' });
    }
  });

  router.get('/account/public-profile/:uid', async (req, res) => {
    const viewer = await requireUser(req, res);
    if (!viewer) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });

    const uid = String(req.params.uid || '').trim();
    if (!uid) return res.status(400).json({ ok: false, error: 'User ID is required.' });

    try {
      const snapshot = await db.ref(`users/${uid}`).get();
      if (!snapshot.exists()) return res.status(404).json({ ok: false, error: 'Profile not found.' });
      return res.json({ ok: true, profile: publicProfile(snapshot.val() || {}) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not load profile.' });
    }
  });

  return router;
}
