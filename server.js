import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { createCloudinarySignature, getCloudinaryConfig } from "./services/cloudinary-signature.js";
import { cleanupInactiveAccounts } from "./services/account-cleanup.js";
import { deleteAccountData } from "./services/account-delete.js";
import { toggleFollow, getFollowStatus } from "./services/social-follow.js";
import { createAccountContactRouter } from "./routes/account-contact.js";
import { createAccountVisibilityRouter } from "./routes/account-visibility.js";
import { createMediaEngagementRouter } from "./routes/media-engagement.js";
import { createSocialBlockRouter } from "./routes/social-block.js";
import { createEarningsRouter } from "./routes/earnings.js";
import { createMessagesRouter } from "./routes/messages.js";
import { createFollowRequestsRouter } from "./routes/follow-requests.js";

const app = express();
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRODUCTION_FRONTEND_ORIGINS = ["https://yashwanthputtarajegowda.github.io"];
const CORS_ORIGINS = Array.from(new Set([
  ...PRODUCTION_FRONTEND_ORIGINS,
  ...String(process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:3000").split(","),
].map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean)));

function initFirebaseAdmin() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), databaseURL: DATABASE_URL });
}

const firebaseAdmin = initFirebaseAdmin();
const db = firebaseAdmin ? getDatabaseWithUrl(DATABASE_URL, firebaseAdmin) : null;
const auth = firebaseAdmin ? admin.auth(firebaseAdmin) : null;

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const normalizedOrigin = String(origin).replace(/\/$/, "");
    if (CORS_ORIGINS.includes(normalizedOrigin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
  methods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "Indo-Backend", firebaseAdmin: Boolean(firebaseAdmin), databaseConfigured: Boolean(db) }));

function normalizeUserId(value) { return String(value || "").trim().toLowerCase().replace(/^@/, ""); }
function userIdKey(userId) { return userId.replace(/\./g, "%2E").replace(/#/g, "%23").replace(/\$/g, "%24").replace(/\//g, "%2F").replace(/\[/g, "%5B").replace(/\]/g, "%5D"); }
function validUserId(userId) { return /^[a-z0-9._-]{1,50}$/.test(userId); }

async function requireUser(req, res) {
  if (!auth) { res.status(503).json({ ok: false, error: "Firebase Admin is not configured on the backend." }); return null; }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) { res.status(401).json({ ok: false, error: "Authentication required." }); return null; }
  try { return await auth.verifyIdToken(header.slice(7)); }
  catch { res.status(401).json({ ok: false, error: "Invalid authentication token." }); return null; }
}

app.use("/api", createAccountContactRouter({ db, auth, requireUser }));
app.use("/api", createAccountVisibilityRouter({ db, requireUser }));
app.use("/api", createEarningsRouter({ db, requireUser }));
app.use("/api", createMediaEngagementRouter({ db, requireUser }));
app.use("/api", createSocialBlockRouter({ db, requireUser }));
app.use("/api", createMessagesRouter({ db, requireUser }));
app.use("/api", createFollowRequestsRouter({ db, requireUser }));

app.post("/api/media/signature", async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const kind = String(req.body?.kind || "video").trim().toLowerCase();
  const folder = kind === "story" ? "indo/stories" : "indo/videos";
  try { return res.json({ ok: true, ...getCloudinaryConfig(), timestamp, folder, signature: createCloudinarySignature(timestamp, { folder }) }); }
  catch { return res.status(503).json({ ok: false, error: "Video upload is temporarily unavailable." }); }
});

app.post("/api/media/videos", async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const mediaType = req.body?.mediaType === "reel" ? "reel" : "video";
  const publicId = String(req.body?.publicId || "").trim();
  const secureUrl = String(req.body?.secureUrl || "").trim();
  const title = String(req.body?.title || "").trim().slice(0, 120);
  const caption = String(req.body?.caption || "").trim().slice(0, 500);
  if (!publicId || !secureUrl || !/^https:\/\//i.test(secureUrl)) return res.status(400).json({ ok: false, error: "Uploaded video could not be published." });
  try {
    const profile = (await db.ref(`users/${user.uid}`).get()).val() || {};
    const videoRef = db.ref("videos").push();
    const video = { id: videoRef.key, mediaType, ownerUid: user.uid, creator: profile.username || `@${user.uid.slice(0, 8)}`, creatorName: profile.name || "Indo User", title: title || (mediaType === "reel" ? "Untitled reel" : "Untitled video"), caption, publicId, secureUrl, videoUrl: secureUrl, duration: Number(req.body?.duration || 0), width: Number(req.body?.width || 0), height: Number(req.body?.height || 0), views: 0, likes: 0, createdAt: admin.database.ServerValue.TIMESTAMP };
    await videoRef.set(video);
    return res.status(201).json({ ok: true, video });
  } catch { return res.status(500).json({ ok: false, error: "Could not publish the video." }); }
});

app.get("/api/media/videos", async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const type = String(req.query.type || "").trim().toLowerCase();
  try {
    const snapshot = await db.ref("videos").get();
    let videos = Object.values(snapshot.val() || {})
      .filter((item) => item && (item.secureUrl || item.videoUrl || item.url))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (type === "video" || type === "reel") videos = videos.filter((item) => (item.mediaType || "video") === type);
    return res.json({ ok: true, videos: videos.slice(0, limit) });
  } catch { return res.status(500).json({ ok: false, error: "Could not load videos." }); }
});

app.post("/api/media/videos/:videoId/view", async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const videoId = String(req.params.videoId || "").trim();
  if (!videoId) return res.status(400).json({ ok: false, error: "Video ID is required." });
  try {
    const videoRef = db.ref(`videos/${videoId}`); const snapshot = await videoRef.get();
    if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Video not found." });
    const result = await videoRef.child("views").transaction((current) => (Number(current) || 0) + 1);
    return res.json({ ok: true, videoId, views: Number(result.snapshot.val()) || 0 });
  } catch { return res.status(500).json({ ok: false, error: "Could not record video view." }); }
});

app.post("/api/stories", async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const publicId = String(req.body?.publicId || "").trim(); const secureUrl = String(req.body?.secureUrl || "").trim();
  if (!publicId || !secureUrl) return res.status(400).json({ ok: false, error: "Uploaded story data is required." });
  try {
    const profile = (await db.ref(`users/${user.uid}`).get()).val() || {}; const ref = db.ref("stories").push();
    const story = { id: ref.key, ownerUid: user.uid, username: profile.username || `@${user.uid.slice(0, 8)}`, name: profile.name || "Indo User", publicId, secureUrl, createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    await ref.set(story); return res.status(201).json({ ok: true, story });
  } catch { return res.status(500).json({ ok: false, error: "Could not save story." }); }
});

app.get("/api/stories", async (req, res) => {
  const user = await requireUser(req, res); if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  try {
    const snapshot = await db.ref("stories").orderByChild("expiresAt").startAt(Date.now()).get();
    const stories = Object.values(snapshot.val() || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    return res.json({ ok: true, stories });
  } catch { return res.status(500).json({ ok: false, error: "Could not load stories." }); }
});

app.get("/api/account/profile/:username", async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const username = normalizeUserId(req.params.username);
  if (!validUserId(username)) return res.status(400).json({ ok: false, error: "Invalid User ID." });
  try {
    const claim = await db.ref(`usernames/${userIdKey(username)}`).get();
    if (!claim.exists() || !claim.val()?.uid) return res.status(404).json({ ok: false, error: "Profile not found." });
    const profileSnapshot = await db.ref(`users/${claim.val().uid}`).get();
    if (!profileSnapshot.exists()) return res.status(404).json({ ok: false, error: "Profile not found." });
    return res.json({ ok: true, profile: profileSnapshot.val() });
  } catch {
    return res.status(500).json({ ok: false, error: "Could not load profile." });
  }
});

app.get("/api/account/me", async (req, res) => {
  const user = await requireUser(req, res); if (!user) return; if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  try { const snapshot = await db.ref(`users/${user.uid}`).get(); if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Profile not found." }); return res.json({ ok: true, profile: snapshot.val() }); }
  catch { return res.status(500).json({ ok: false, error: "Could not load profile." }); }
});

app.patch("/api/account/profile", async (req, res) => {
  const user = await requireUser(req, res); if (!user) return; if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const name = String(req.body?.name || "").trim(); const bio = String(req.body?.bio || "").trim().slice(0, 160);
  if (!name) return res.status(400).json({ ok: false, error: "User Name is required." });
  try { const userRef = db.ref(`users/${user.uid}`); const snapshot = await userRef.get(); if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Profile not found." }); await userRef.update({ name, bio, lastActiveAt: admin.database.ServerValue.TIMESTAMP }); const updated = await userRef.get(); return res.json({ ok: true, profile: updated.val() }); }
  catch { return res.status(500).json({ ok: false, error: "Could not update profile." }); }
});

app.post("/api/account/check-user-id", async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const userId = normalizeUserId(req.body?.userId); if (!validUserId(userId)) return res.status(400).json({ ok: false, error: "User ID can contain only letters, numbers, dots, underscores, and hyphens." });
  try { const snapshot = await db.ref(`usernames/${userIdKey(userId)}`).get(); if (!snapshot.exists()) return res.json({ ok: true, userId, available: true, exists: false }); const claim = snapshot.val() || {}; let profile = null; if (claim.uid) { const userSnapshot = await db.ref(`users/${claim.uid}`).get(); if (userSnapshot.exists()) { const value = userSnapshot.val() || {}; profile = { uid: claim.uid, userId: value.username || `@${userId}`, name: value.name || "Indo User" }; } } return res.json({ ok: true, userId, available: false, exists: Boolean(profile), user: profile }); }
  catch { return res.status(500).json({ ok: false, error: "Could not check User ID." }); }
});

app.post("/api/account/claim-user-id", async (req, res) => {
  const user = await requireUser(req, res); if (!user) return; if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const userId = normalizeUserId(req.body?.userId); const name = String(req.body?.name || "").trim(); const accountType = req.body?.accountType === "private" ? "private" : "public";
  if (!validUserId(userId)) return res.status(400).json({ ok: false, error: "Invalid User ID." }); if (!name) return res.status(400).json({ ok: false, error: "User name is required." });
  try {
    const userRef = db.ref(`users/${user.uid}`); const existingProfile = await userRef.get(); if (existingProfile.exists() && existingProfile.val()?.usernameKey) return res.status(409).json({ ok: false, error: "This account already has a User ID. One user can have only one User ID." });
    const usernameRef = db.ref(`usernames/${userIdKey(userId)}`); const claim = await usernameRef.transaction((current) => { if (current === null) return { uid: user.uid, username: `@${userId}` }; if (current?.uid === user.uid) return current; return undefined; });
    if (!claim.committed) return res.status(409).json({ ok: false, error: `@${userId} is already taken. Choose another User ID.` });
    const counterRef = db.ref("system/indoCounter"); const counter = await counterRef.transaction((current) => (Number(current) || 1165) + 1); if (!counter.committed) { await usernameRef.remove(); return res.status(500).json({ ok: false, error: "Could not generate Indo ID." }); }
    const indoId = `INDO-${String(counter.snapshot.val()).padStart(6, "0")}`;
    await userRef.set({ uid: user.uid, indoId, name, username: `@${userId}`, usernameKey: userId, email: user.email || "", accountType, createdAt: existingProfile.exists() ? existingProfile.val()?.createdAt || admin.database.ServerValue.TIMESTAMP : admin.database.ServerValue.TIMESTAMP, lastActiveAt: admin.database.ServerValue.TIMESTAMP });
    return res.json({ ok: true, indoId, username: `@${userId}`, accountType });
  } catch { return res.status(500).json({ ok: false, error: "Could not create account profile." }); }
});

app.post("/api/account/delete", async (req, res) => { const user = await requireUser(req, res); if (!user) return; try { const result = await deleteAccountData({ db, auth, uid: user.uid }); return res.json({ ok: true, ...result }); } catch { return res.status(500).json({ ok: false, error: "Could not delete account." }); } });

app.post("/api/social/follow", async (req, res) => {
  const user = await requireUser(req, res); if (!user) return; const targetUid = String(req.body?.targetUid || "").trim(); const follow = req.body?.follow === true; if (!targetUid) return res.status(400).json({ ok: false, error: "Target user is required." });
  try { const targetSnapshot = await db.ref(`users/${targetUid}`).get(); if (!targetSnapshot.exists()) return res.status(404).json({ ok: false, error: "Target profile not found." }); const result = await toggleFollow({ db, followerUid: user.uid, targetUid, follow }); return res.json({ ok: true, ...result }); }
  catch { return res.status(400).json({ ok: false, error: "Could not update follow status." }); }
});

app.get("/api/social/follow-status/:targetUid", async (req, res) => {
  const user = await requireUser(req, res); if (!user) return; const targetUid = String(req.params.targetUid || "").trim();
  try { const result = await getFollowStatus({ db, followerUid: user.uid, targetUid }); return res.json({ ok: true, ...result }); }
  catch { return res.status(500).json({ ok: false, error: "Could not load follow status." }); }
});

app.post("/api/account/activity", async (req, res) => {
  const user = await requireUser(req, res); if (!user) return; if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  try { await db.ref(`users/${user.uid}/lastActiveAt`).set(admin.database.ServerValue.TIMESTAMP); return res.json({ ok: true, lastActiveAt: Date.now() }); }
  catch { return res.status(500).json({ ok: false, error: "Could not update activity." }); }
});

app.use((error, _req, res, _next) => res.status(500).json({ ok: false, error: error.message || "Internal server error." }));
app.listen(PORT, () => console.log(`Indo backend running on port ${PORT}`));
setInterval(() => { cleanupInactiveAccounts({ db, auth }).catch(() => {}); }, CLEANUP_INTERVAL_MS).unref();

// Railway deploy trigger: keep video-feed fix live.

// Railway deploy trigger: keep video-feed fix live.
