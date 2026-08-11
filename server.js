import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { getDatabaseWithUrl } from 'firebase-admin/database';
import { createCloudinarySignature, getCloudinaryConfig } from './services/cloudinary-signature.js';
import { cleanupInactiveAccounts } from './services/account-cleanup.js';
import { deleteAccountData } from './services/account-delete.js';

const app = express();
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://indo-174f0-default-rtdb.firebaseio.com';
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function initFirebaseAdmin() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || 'indo-174f0';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) return null;
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), databaseURL: DATABASE_URL });
}

const firebaseAdmin = initFirebaseAdmin();
const db = firebaseAdmin ? getDatabaseWithUrl(DATABASE_URL, firebaseAdmin) : null;
const auth = firebaseAdmin ? admin.auth(firebaseAdmin) : null;

app.use(cors({
  origin(origin, callback) {
    if (!origin || CORS_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'Indo-Backend', firebaseAdmin: Boolean(firebaseAdmin), databaseConfigured: Boolean(db) });
});

function normalizeUserId(value) { return String(value || '').trim().toLowerCase().replace(/^@/, ''); }
function userIdKey(userId) {
  return userId.replace(/\\./g, '%2E').replace(/#/g, '%23').replace(/\\$/g, '%24').replace(/\\//g, '%2F').replace(/\\[/g, '%5B').replace(/\\]/g, '%5D');
}
function validUserId(userId) { return /^[a-z0-9._-]{1,50}$/.test(userId); }

async function requireUser(req, res) {
  if (!auth) { res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' }); return null; }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) { res.status(401).json({ ok: false, error: 'Authentication required.' }); return null; }
  try { return await auth.verifyIdToken(header.slice(7)); }
  catch { res.status(401).json({ ok: false, error: 'Invalid authentication token.' }); return null; }
}

app.post('/api/media/signature', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const timestamp = Math.floor(Date.now() / 1000);
  try { return res.json({ ok: true, ...getCloudinaryConfig(), timestamp, signature: createCloudinarySignature(timestamp) }); }
  catch (error) { return res.status(503).json({ ok: false, error: error.message || 'Cloudinary is not configured.' }); }
});

app.get('/api/account/me', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
  try {
    const snapshot = await db.ref(`users/${user.uid}`).get();
    if (!snapshot.exists()) return res.status(404).json({ ok: false, error: 'Profile not found.' });
    return res.json({ ok: true, profile: snapshot.val() });
  } catch (error) { return res.status(500).json({ ok: false, error: error.message || 'Could not load profile.' }); }
});

app.patch('/api/account/profile', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
  const name = String(req.body?.name || '').trim();
  const bio = String(req.body?.bio || '').trim().slice(0, 160);
  if (!name) return res.status(400).json({ ok: false, error: 'User Name is required.' });
  try {
    const userRef = db.ref(`users/${user.uid}`);
    const snapshot = await userRef.get();
    if (!snapshot.exists()) return res.status(404).json({ ok: false, error: 'Profile not found.' });
    await userRef.update({ name, bio, lastActiveAt: admin.database.ServerValue.TIMESTAMP });
    const updated = await userRef.get();
    return res.json({ ok: true, profile: updated.val() });
  } catch (error) { return res.status(500).json({ ok: false, error: error.message || 'Could not update profile.' }); }
});

app.post('/api/account/check-user-id', async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
  const userId = normalizeUserId(req.body?.userId);
  if (!validUserId(userId)) return res.status(400).json({ ok: false, error: 'User ID can contain only letters, numbers, dots, underscores, and hyphens.' });
  try {
    const snapshot = await db.ref(`usernames/${userIdKey(userId)}`).get();
    if (!snapshot.exists()) return res.json({ ok: true, userId, available: true, exists: false });
    const claim = snapshot.val() || {};
    let profile = null;
    if (claim.uid) {
      const userSnapshot = await db.ref(`users/${claim.uid}`).get();
      if (userSnapshot.exists()) {
        const value = userSnapshot.val() || {};
        profile = { userId: value.username || `@${userId}`, name: value.name || 'Indo User' };
      }
    }
    return res.json({ ok: true, userId, available: false, exists: Boolean(profile), user: profile });
  } catch (error) { return res.status(500).json({ ok: false, error: error.message || 'Could not check User ID.' }); }
});

app.post('/api/account/claim-user-id', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
  const userId = normalizeUserId(req.body?.userId);
  const name = String(req.body?.name || '').trim();
  const accountType = req.body?.accountType === 'private' ? 'private' : 'public';
  if (!validUserId(userId)) return res.status(400).json({ ok: false, error: 'Invalid User ID.' });
  if (!name) return res.status(400).json({ ok: false, error: 'User name is required.' });
  try {
    const userRef = db.ref(`users/${user.uid}`);
    const existingProfile = await userRef.get();
    if (existingProfile.exists() && existingProfile.val()?.usernameKey) {
      return res.status(409).json({ ok: false, error: 'This account already has a User ID. One user can have only one User ID.' });
    }
    const usernameRef = db.ref(`usernames/${userIdKey(userId)}`);
    const claim = await usernameRef.transaction((current) => {
      if (current === null) return { uid: user.uid, username: `@${userId}` };
      if (current?.uid === user.uid) return current;
      return undefined;
    });
    if (!claim.committed) return res.status(409).json({ ok: false, error: `@${userId} is already taken. Choose another User ID.` });
    const counterRef = db.ref('system/indoCounter');
    const counter = await counterRef.transaction((current) => (Number(current) || 1165) + 1);
    if (!counter.committed) { await usernameRef.remove(); return res.status(500).json({ ok: false, error: 'Could not generate Indo ID.' }); }
    const indoId = `INDO-${String(counter.snapshot.val()).padStart(6, '0')}`;
    await userRef.set({
      uid: user.uid, indoId, name, username: `@${userId}`, usernameKey: userId, email: user.email || '', accountType,
      createdAt: existingProfile.exists() ? (existingProfile.val()?.createdAt || admin.database.ServerValue.TIMESTAMP) : admin.database.ServerValue.TIMESTAMP,
      lastActiveAt: admin.database.ServerValue.TIMESTAMP
    });
    return res.json({ ok: true, indoId, username: `@${userId}` });
  } catch (error) { return res.status(500).json({ ok: false, error: error.message || 'Could not create account profile.' }); }
});

app.post('/api/account/delete', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  try {
    const result = await deleteAccountData({ db, auth, uid: user.uid });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Could not delete account.' });
  }
});

app.post('/api/account/activity', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
  try { await db.ref(`users/${user.uid}/lastActiveAt`).set(admin.database.ServerValue.TIMESTAMP); return res.json({ ok: true, lastActiveAt: Date.now() }); }
  catch (error) { return res.status(500).json({ ok: false, error: error.message || 'Could not update activity.' }); }
});

async function runInactiveAccountCleanup() {
  try { const result = await cleanupInactiveAccounts({ db, auth }); console.log('[account-cleanup]', result); }
  catch (error) { console.error('[account-cleanup] failed:', error); }
}
if (db && auth) { runInactiveAccountCleanup(); setInterval(runInactiveAccountCleanup, CLEANUP_INTERVAL_MS); }
app.get('/', (_req, res) => { res.json({ app: 'Indo-Backend', status: 'running' }); });
app.listen(PORT, () => { console.log(`Indo backend running on port ${PORT}`); });
