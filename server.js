import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { getDatabaseWithUrl } from 'firebase-admin/database';
import { createCloudinarySignature, getCloudinaryConfig } from './services/cloudinary-signature.js';
import { cleanupInactiveAccounts } from './services/account-cleanup.js';
import { deleteAccountData } from './services/account-delete.js';
import { toggleFollow, getFollowStatus } from './services/social-follow.js';

const app = express();
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://indo-174f0-default-rtdb.firebaseio.com';
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',').map((origin) => origin.trim()).filter(Boolean);

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
function userIdKey(userId) { return userId.replace(/\./g, '%2E').replace(/#/g, '%23').replace(/\$/g, '%24').replace(/\//g, '%2F').replace(/\[/g, '%5B').replace(/\]/g, '%5D'); }
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

app.post('/api/media/videos', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
  const mediaType = req.body?.mediaType === 'reel' ? 'reel' : 'video';
  const publicId = String(req.body?.publicId || '').trim();
  const secureUrl = String(req.body?.secureUrl || '').trim();
  const title = String(req.body?.title || '').trim().slice(0, 120);
  const caption = String(req.body?.caption || '').trim().slice(0, 500);
  if (!publicId || !secureUrl) return res.status(400).json({ ok: false, error: 'Uploaded video data is required.' });
  try {
    const profileSnapshot = await db.ref(`users/${user.uid}`).get();
    const profile = profileSnapshot.val() || {};
    const videoRef = db.ref('videos').push();
    const video = {
      id: videoRef.key,
      mediaType,
      ownerUid: user.uid,
      creator: profile.username || `@${user.uid.slice(0, 8)}`,
      creatorName: profile.name || 'Indo User',
      title: title || (mediaType === 'reel' ? 'Untitled reel' : 'Untitled video'),
      caption,
      publicId,
      secureUrl,
      duration: Number(req.body?.duration || 0),
      width: Number(req.body?.width || 0),
      height: Number(req.body?.height || 0),
      views: 0,
      createdAt: admin.database.ServerValue.TIMESTAMP
    };
    await videoRef.set(video);
    return res.status(201).json({ ok: true, video });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Could not save video.' });
  }
});

app.get('/api/media/videos', async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const type = String(req.query.type || '').trim().toLowerCase();
  try {
    const snapshot = await db.ref('videos').orderByChild('createdAt').limitToLast(100).get();
    let videos = Object.values(snapshot.val() || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (type === 'video' || type === 'reel') videos = videos.filter((item) => (item.mediaType || 'video') === type);
    return res.json({ ok: true, videos: videos.slice(0, limit) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Could not load videos.' });
  }
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
        profile = { uid: claim.uid, userId: value.username || `@${userId}`, name: value.name || 'Indo User' };
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
    await userRef.set({ uid: user.uid, indoId, name, username: `@${userId}`, usernameKey: userId, email: user.email || '', accountType,
      createdAt: existingProfile.exists() ? (existingProfile.val()?.createdAt || admin.database.ServerValue.TIMESTAMP) : admin.database.ServerValue.TIMESTAMP,
      lastActiveAt: admin.database.ServerValue.TIMESTAMP });
    return res.json({ ok: true, indoId, username: `@${userId}` });
  } catch (error) { return res.status(500).json({ ok: false, error: error.message || 'Could not create account profile.' }); }
});

app.post('/api/account/delete', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  try { const result = await deleteAccountData({ db, auth, uid: user.uid }); return res.json({ ok: true, ...result }); }
  catch (error) { return res.status(500).json({ ok: false, error: error.message || 'Could not delete account.' }); }
});

app.post('/api/social/follow', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const targetUid = String(req.body?.targetUid || '').trim();
  const follow = req.body?.follow === true;
  if (!targetUid) return res.status(400).json({ ok: false, error: 'Target user is required.' });
  try {
    const targetSnapshot = await db.ref(`users/${targetUid}`).get();
    if (!targetSnapshot.exists()) return res.status(404).json({ ok: false, error: 'Target profile not found.' });
    const result = await toggleFollow({ db, followerUid: user.uid, targetUid, follow });
    return res.json({ ok: true, ...result });
  } catch (error) { return res.status(400).json({ ok: false, error: error.message || 'Could not update follow status.' }); }
});

app.get('/api/social/follow-status/:targetUid', async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const targetUid = String(req.params.targetUid || '').trim();
  try {
    const result = await getFollowStatus({ db, followerUid: user.uid, targetUid });
    return res.json({ ok: true, ...result });
  } catch (error) { return res.status(500).json({ ok: false, error: error.message || 'Could not load follow status.' }); }
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
