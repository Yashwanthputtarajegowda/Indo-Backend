import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { createCloudinarySignature, getCloudinaryConfig, destroyCloudinaryVideo } from "./services/cloudinary-signature.js";
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
const BACKEND_VERSION = "20260813-followers-v3";
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
app.use((req, res, next) => { res.setHeader("X-Indo-Backend-Version", BACKEND_VERSION); next(); });

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "Indo-Backend", backendVersion: BACKEND_VERSION, firebaseAdmin: Boolean(firebaseAdmin), databaseConfigured: Boolean(db) }));

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

app.post("/api/media/videos", async (req, res) => { /* existing endpoint */ });

app.get("/api/media/videos", async (req, res) => { /* existing endpoint */ });

app.post("/api/media/videos/:videoId/view", async (req, res) => { /* existing endpoint */ });

app.post("/api/media/videos/:videoId/delete", async (req, res) => { /* existing endpoint */ });

app.post("/api/stories", async (req, res) => { /* existing endpoint */ });
app.get("/api/stories", async (req, res) => { /* existing endpoint */ });
app.post("/api/stories/:storyId/delete", async (req, res) => { /* existing endpoint */ });
app.get("/api/account/profile/:username", async (req, res) => { /* existing endpoint */ });
app.get("/api/account/me", async (req, res) => { /* existing endpoint */ });
app.patch("/api/account/profile", async (req, res) => { /* existing endpoint */ });

app.use((error, _req, res, _next) => { console.error(error); if (res.headersSent) return; return res.status(500).json({ ok: false, error: error?.message || "Internal server error." }); });

async function start() {
  if (firebaseAdmin && db) { try { await cleanupInactiveAccounts({ db, auth }); } catch (error) { console.warn("Account cleanup failed:", error?.message || error); } }
  app.listen(PORT, () => console.log(`Indo backend listening on port ${PORT}`));
  setInterval(() => { cleanupInactiveAccounts({ db, auth }).catch((error) => console.warn("Scheduled account cleanup failed:", error?.message || error)); }, CLEANUP_INTERVAL_MS).unref?.();
}

start();
