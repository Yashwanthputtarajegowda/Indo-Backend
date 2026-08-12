import express from 'express';

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

  return router;
}
