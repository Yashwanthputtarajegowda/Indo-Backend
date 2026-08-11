import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';

const app = express();
const PORT = process.env.PORT || 3001;

function initFirebaseAdmin() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || 'indo-174f0';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) return null;
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://indo-174f0-default-rtdb.firebaseio.com'
  });
}

const firebaseAdmin = initFirebaseAdmin();
const db = firebaseAdmin ? admin.database() : null;
const auth = firebaseAdmin ? admin.auth() : null;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'Indo-Backend', firebaseAdmin: Boolean(firebaseAdmin) });
});

function normalizeUserId(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '');
}

// Firebase Realtime Database keys cannot contain . # $ / [ ]. Encode those
// characters so User IDs such as yashwanth#07 remain valid and unique.
function userIdKey(userId) {
  return userId
    .replace(/\./g, '%2E')
    .replace(/#/g, '%23')
    .replace(/\$/g, '%24')
    .replace(/\//g, '%2F')
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D');
}

function validUserId(userId) {
  return userId.length >= 1 && userId.length <= 50;
}

async function requireUser(req, res) {
  if (!auth) {
    res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    return null;
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'Authentication required.' });
    return null;
  }
  try {
    return await auth.verifyIdToken(header.slice(7));
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid authentication token.' });
    return null;
  }
}

app.post('/api/account/check-user-id', async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
  const userId = normalizeUserId(req.body?.userId);
  if (!validUserId(userId)) return res.status(400).json({ ok: false, error: 'User ID must be 1–50 characters.' });
  try {
    const snapshot = await db.ref(`usernames/${userIdKey(userId)}`).get();
    return res.json({ ok: true, userId, available: !snapshot.exists() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Could not check User ID.' });
  }
});

app.post('/api/account/claim-user-id', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
  const userId = normalizeUserId(req.body?.userId);
  const name = String(req.body?.name || '').trim();
  const accountType = req.body?.accountType === 'private' ? 'private' : 'public';
  if (!validUserId(userId)) return res.status(400).json({ ok: false, error: 'User ID must be 1–50 characters.' });
  if (!name) return res.status(400).json({ ok: false, error: 'User name is required.' });

  try {
    const usernameRef = db.ref(`usernames/${userIdKey(userId)}`);
    const claim = await usernameRef.transaction(current => current === null ? { uid: user.uid, username: `@${userId}` } : undefined);
    if (!claim.committed) return res.status(409).json({ ok: false, error: `@${userId} is already taken. Choose another User ID.` });

    const counterRef = db.ref('system/indoCounter');
    const counter = await counterRef.transaction(current => (Number(current) || 1165) + 1);
    if (!counter.committed) {
      await usernameRef.remove();
      return res.status(500).json({ ok: false, error: 'Could not generate Indo ID.' });
    }

    const indoId = `INDO-${String(counter.snapshot.val()).padStart(6, '0')}`;
    await db.ref(`users/${user.uid}`).set({
      uid: user.uid,
      indoId,
      name,
      username: `@${userId}`,
      usernameKey: userId,
      email: user.email || '',
      accountType,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    return res.json({ ok: true, indoId, username: `@${userId}` });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Could not create account profile.' });
  }
});

app.get('/', (_req, res) => {
  res.json({ app: 'Indo-Backend', status: 'running' });
});

app.listen(PORT, () => {
  console.log(`Indo backend running on port ${PORT}`);
});
