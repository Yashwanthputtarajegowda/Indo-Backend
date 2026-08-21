import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { cleanupInactiveAccounts } from "./services/account-cleanup.js";
import { canonicalUserRoot, migrateAllUsersToCanonical, syncCanonicalUser } from "./services/user-canonical.js";
import { saveCanonicalVideo, updateCanonicalVideoViews, deleteCanonicalVideo } from "./services/canonical-content.js";
import { createAccountContactRouter } from "./routes/account-contact.js";
import { createAccountVisibilityRouter } from "./routes/account-visibility.js";
import { createAccountClaimRouter } from "./routes/account-claim.js";
import { createCanonicalMediaEngagementRouter } from "./routes/media-engagement-canonical.js";
import { createSocialBlockRouter } from "./routes/social-block.js";
import { createEarningsRouter } from "./routes/earnings.js";
import { createMessagesRouter } from "./routes/messages.js";
import { createFollowRequestsRouter } from "./routes/follow-requests.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createTelegramMediaUploadRouter } from "./routes/media-upload-telegram.js";
import { createExternalVideoLinksRouter } from "./routes/external-video-links.js";
import { createGoogleDriveVideoRouter } from "./routes/google-drive-video.js";

const app = express();
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BACKEND_VERSION = "20260821-google-drive-delete-v2";
const CANONICAL_SCHEMA_VERSION = 3;
const PRODUCTION_FRONTEND_ORIGINS = ["https://yashwanthputtarajegowda.github.io"];
const CORS_ORIGINS = Array.from(new Set([...PRODUCTION_FRONTEND_ORIGINS, ...String(process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:3000").split(",")].map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean)));

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
    const normalized = String(origin).replace(/\/$/, "");
    if (CORS_ORIGINS.includes(normalized)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Range", "X-Upload-Id", "X-File-Name", "X-File-Size", "X-Mime-Type", "X-Media-Type", "X-Title", "X-Caption", "X-Privacy", "X-Allow-Comments", "X-Allow-Duet", "X-Category", "X-Tags", "X-Location", "X-Duration", "X-Width", "X-Height"],
  exposedHeaders: ["Accept-Ranges", "Content-Length", "Content-Range", "Content-Type"],
  maxAge: 86400,
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: "2mb", strict: true }));
app.use((req, res, next) => { res.setHeader("X-Indo-Backend-Version", BACKEND_VERSION); next(); });

const apiLimiter = rateLimit({ windowMs: 60000, max: 180, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: "Too many requests. Please try again later." } });
const authLimiter = rateLimit({ windowMs: 600000, max: 60, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: "Too many authentication requests. Please try again later." } });
app.use("/api", apiLimiter);

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "Indo-Backend", backendVersion: BACKEND_VERSION, canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION, firebaseAdmin: Boolean(firebaseAdmin), databaseConfigured: Boolean(db), mediaStorage: "telegram-external-google-drive" }));

function normalizeUserId(value) { return String(value || "").trim().toLowerCase().replace(/^@/, ""); }
function userIdKey(userId) { return userId.replace(/\./g, "%2E").replace(/#/g, "%23").replace(/\$/g, "%24").replace(/\//g, "%2F").replace(/\[/g, "%5B").replace(/\]/g, "%5D"); }
function validUserId(userId) { return /^[a-z0-9._-]{1,50}$/.test(userId); }

function rebuildTelegramEmbed(source) {
  try {
    const url = new URL(String(source || ""));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["t.me", "telegram.me"].includes(host) && !host.endsWith("telegram.org")) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "s" && parts.length >= 3 && /^\d+$/.test(parts[2])) return `https://t.me/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}?embed=1`;
    if (parts[0] === "c" && parts.length >= 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) return `https://t.me/c/${encodeURIComponent(parts[1])}/${encodeURIComponent(parts[2])}?embed=1`;
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) return `https://t.me/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}?embed=1`;
  } catch {}
  return "";
}
function rebuildYoutubeEmbed(source) {
  try {
    const url = new URL(String(source || ""));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") { const id = url.pathname.slice(1).split("/")[0]; return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}?playsinline=1&rel=0&modestbranding=1` : ""; }
    if (!["youtube.com", "m.youtube.com"].includes(host)) return "";
    const v = url.searchParams.get("v");
    if (v) return `https://www.youtube.com/embed/${encodeURIComponent(v)}?playsinline=1&rel=0&modestbranding=1`;
    const parts = url.pathname.split("/").filter(Boolean); const i = parts.findIndex((part) => ["shorts", "embed", "live"].includes(part)); const id = i >= 0 ? parts[i + 1] : "";
    return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}?playsinline=1&rel=0&modestbranding=1` : "";
  } catch { return ""; }
}
function normalizeExternalPlayback(item) {
  if (!item || String(item.storage?.provider || "").toLowerCase() !== "external-url") return item;
  const source = String(item.sourceUrl || item.external?.sourceUrl || "").trim();
  if (!source) return item;
  const telegramEmbed = rebuildTelegramEmbed(source);
  if (telegramEmbed) return { ...item, sourceType: "telegram", playerType: "telegram-embed", embedUrl: telegramEmbed, videoUrl: source, secureUrl: source, streamUrl: "" };
  const youtubeEmbed = rebuildYoutubeEmbed(source);
  if (youtubeEmbed) return { ...item, sourceType: "youtube", playerType: "youtube", embedUrl: youtubeEmbed, videoUrl: source, secureUrl: source, streamUrl: "" };
  return item;
}

async function requireUser(req, res) {
  if (!auth) { res.status(503).json({ ok: false, error: "Authentication service is unavailable." }); return null; }
  const header = String(req.headers.authorization || "");
  if (!/^Bearer\s+\S+$/i.test(header)) { res.status(401).json({ ok: false, error: "Authentication required." }); return null; }
  try { return await auth.verifyIdToken(header.replace(/^Bearer\s+/i, "").trim(), true); } catch { res.status(401).json({ ok: false, error: "Invalid or expired authentication token." }); return null; }
}

app.use("/api/auth", authLimiter);
app.use("/api", createAccountContactRouter({ db, auth, requireUser }));
app.use("/api", createAccountVisibilityRouter({ db, requireUser }));
app.use("/api", createAccountClaimRouter({ db, requireUser }));
app.use("/api", createEarningsRouter({ db, requireUser }));
app.use("/api", createCanonicalMediaEngagementRouter({ db, requireUser }));
app.use("/api", createSocialBlockRouter({ db, requireUser }));
app.use("/api", createMessagesRouter({ db, requireUser }));
app.use("/api", createFollowRequestsRouter({ db, requireUser }));
app.use("/api", createNotificationsRouter({ db, requireUser }));
app.use("/api", createTelegramMediaUploadRouter({ db, requireUser }));
app.use("/api", createExternalVideoLinksRouter({ db, requireUser }));
app.use("/api", createGoogleDriveVideoRouter({ db, requireUser }));

app.get("/api/media/videos", async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const type = String(req.query.type || "").trim().toLowerCase();
  try {
    const snapshot = await db.ref("videos").get();
    let videos = Object.values(snapshot.val() || {}).filter((item) => item).map(normalizeExternalPlayback);
    videos.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (type === "video" || type === "reel") videos = videos.filter((item) => (item.mediaType || "video") === type);
    return res.json({ ok: true, videos: videos.slice(0, limit) });
  } catch { return res.status(500).json({ ok: false, error: "Could not load videos." }); }
});

app.post("/api/media/videos/:videoId/view", async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const videoId = String(req.params.videoId || "").trim();
  try {
    const videoRef = db.ref(`videos/${videoId}`);
    const snapshot = await videoRef.get();
    if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Video not found." });
    const video = snapshot.val() || {};
    if (!video.id) return res.status(404).json({ ok: false, error: "Video not found." });
    const result = await videoRef.child("views").transaction((current) => (Number(current) || 0) + 1);
    await updateCanonicalVideoViews({ db, uid: video.ownerUid, videoId, views: Number(result.snapshot.val()) || 0 });
    return res.json({ ok: true, videoId, views: Number(result.snapshot.val()) || 0 });
  } catch { return res.status(500).json({ ok: false, error: "Could not record video view." }); }
});

app.post("/api/media/videos/:videoId/delete", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const videoId = String(req.params.videoId || "").trim();
  try {
    const videoRef = db.ref(`videos/${videoId}`);
    const snapshot = await videoRef.get();
    if (!snapshot.exists()) return res.json({ ok: true, videoId, alreadyDeleted: true });
    const video = snapshot.val() || {};
    if (String(video.ownerUid || "") !== String(user.uid || "")) return res.status(403).json({ ok: false, error: "You can delete only your own video." });
    const googleDriveFileId = String(video.googleDrive?.fileId || video.drive?.fileId || video.storage?.fileId || video.googleDriveFileId || "").trim();
    await deleteCanonicalVideo({ db, uid: user.uid, videoId, googleDriveFileId });
    await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => Math.max(0, (Number(current) || 0) - 1));
    await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => Math.max(0, (Number(current) || 0) - 1));
    return res.json({ ok: true, videoId, deleted: true, googleDriveFileId: Boolean(googleDriveFileId) });
  } catch (error) {
    console.error("Video delete failed:", error?.stack || error?.message || error);
    const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500;
    return res.status(status).json({ ok: false, deleted: false, error: String(error?.message || "Could not delete video.").slice(0, 500), code: String(error?.code || "VIDEO_DELETE_FAILED") });
  }
});

app.get("/api/account/profile/:username", async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const username = normalizeUserId(req.params.username);
  if (!validUserId(username)) return res.status(400).json({ ok: false, error: "Invalid User ID." });
  try {
    const claim = await db.ref(`usernames/${userIdKey(username)}`).get();
    if (!claim.exists() || !claim.val()?.uid) return res.status(404).json({ ok: false, error: "Profile not found." });
    const targetUid = String(claim.val().uid);
    const canonical = await syncCanonicalUser({ db, uid: targetUid, includeContent: true });
    return res.json({ ok: true, profile: { ...canonical.profile, accountType: canonical.settings.accountType }, stats: canonical.stats, social: canonical.social });
  } catch { return res.status(500).json({ ok: false, error: "Could not load profile." }); }
});

app.get("/api/account/public-profile/:uid", async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const uid = String(req.params.uid || "").trim();
  if (!uid || uid.length > 128) return res.status(400).json({ ok: false, error: "Invalid profile UID." });
  try {
    const profileSnapshot = await db.ref(`users/${uid}`).get();
    if (!profileSnapshot.exists()) return res.status(404).json({ ok: false, error: "Profile not found." });
    const profile = profileSnapshot.val() || {};
    return res.json({ ok: true, profile: profile.profile || profile });
  } catch { return res.status(500).json({ ok: false, error: "Could not load profile." }); }
});

app.get("/api/account/me", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  try {
    const canonical = await syncCanonicalUser({ db, uid: user.uid, includeContent: true });
    return res.json({ ok: true, profile: canonical.profile, stats: canonical.stats, settings: canonical.settings, social: canonical.social });
  } catch { return res.status(500).json({ ok: false, error: "Could not load account." }); }
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled API error:", error?.stack || error?.message || error);
  return res.status(Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500).json({ ok: false, error: String(error?.message || "Internal server error.").slice(0, 500) });
});

app.listen(PORT, () => console.log(`Indo-Backend listening on port ${PORT}`));

setInterval(() => {
  cleanupInactiveAccounts({ db }).catch((error) => console.error("Account cleanup failed:", error?.message || error));
}, CLEANUP_INTERVAL_MS).unref();

migrateAllUsersToCanonical({ db }).catch((error) => console.error("Canonical user migration failed:", error?.message || error));

void saveCanonicalVideo;
