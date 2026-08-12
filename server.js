import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import {
  createCloudinarySignature,
  getCloudinaryConfig,
} from "./services/cloudinary-signature.js";
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
const DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://indo-174f0-default-rtdb.firebaseio.com";
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRODUCTION_FRONTEND_ORIGINS = [
  "https://yashwanthputtarajegowda.github.io",
];
const CORS_ORIGINS = Array.from(
  new Set(
    [
      ...PRODUCTION_FRONTEND_ORIGINS,
      ...String(
        process.env.CORS_ORIGINS ||
          "http://localhost:5173,http://localhost:3000",
      ).split(","),
    ]
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  ),
);

function initFirebaseAdmin() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL: DATABASE_URL,
  });
}

const firebaseAdmin = initFirebaseAdmin();
const db = firebaseAdmin
  ? getDatabaseWithUrl(DATABASE_URL, firebaseAdmin)
  : null;
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

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "Indo-Backend",
    firebaseAdmin: Boolean(firebaseAdmin),
    databaseConfigured: Boolean(db),
  });
});

function normalizeUserId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}
function userIdKey(userId) {
  return userId
    .replace(/\./g, "%2E")
    .replace(/#/g, "%23")
    .replace(/\$/g, "%24")
    .replace(/\//g, "%2F")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D");
}
function validUserId(userId) {
  return /^[a-z0-9._-]{1,50}$/.test(userId);
}

async function requireUser(req, res) {
  if (!auth) {
    res.status(503).json({ ok: false, error: "Service unavailable." });
    return null;
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    res.status(401).json({ ok: false, error: "Authentication required." });
    return null;
  }
  try {
    return await auth.verifyIdToken(header.slice(7));
  } catch {
    res.status(401).json({ ok: false, error: "Invalid authentication token." });
    return null;
  }
}

app.use("/api", createAccountContactRouter({ db, auth, requireUser }));
app.use("/api", createAccountVisibilityRouter({ db, requireUser }));
app.use("/api", createEarningsRouter({ db, requireUser }));
app.use("/api", createMediaEngagementRouter({ db, requireUser }));
app.use("/api", createSocialBlockRouter({ db, requireUser }));
app.use("/api", createMessagesRouter({ db, requireUser }));
app.use("/api", createFollowRequestsRouter({ db, requireUser }));

app.post("/api/media/signature", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const kind = String(req.body?.kind || "video").trim().toLowerCase();
  const folder = kind === "story" ? "indo/stories" : "indo/videos";
  try {
    return res.json({
      ok: true,
      ...getCloudinaryConfig(),
      timestamp,
      folder,
      signature: createCloudinarySignature(timestamp, { folder }),
    });
  } catch {
    return res.status(503).json({ ok: false, error: "Video upload is temporarily unavailable." });
  }
});

app.post("/api/media/videos", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const mediaType = req.body?.mediaType === "reel" ? "reel" : "video";
  const publicId = String(req.body?.publicId || "").trim();
  const secureUrl = String(req.body?.secureUrl || "").trim();
  const title = String(req.body?.title || "").trim().slice(0, 120);
  const caption = String(req.body?.caption || "").trim().slice(0, 500);

  if (!publicId || !secureUrl || !/^https:\/\//i.test(secureUrl)) {
    return res.status(400).json({ ok: false, error: "Uploaded video could not be published." });
  }

  try {
    const profileSnapshot = await db.ref(`users/${user.uid}`).get();
    const profile = profileSnapshot.val() || {};
    const videoRef = db.ref("videos").push();
    const video = {
      id: videoRef.key,
      mediaType,
      ownerUid: user.uid,
      creator: profile.username || `@${user.uid.slice(0, 8)}`,
      creatorName: profile.name || "Indo User",
      title: title || (mediaType === "reel" ? "Untitled reel" : "Untitled video"),
      caption,
      publicId,
      secureUrl,
      videoUrl: secureUrl,
      duration: Number(req.body?.duration || 0),
      width: Number(req.body?.width || 0),
      height: Number(req.body?.height || 0),
      views: 0,
      likes: 0,
      createdAt: admin.database.ServerValue.TIMESTAMP,
    };
    await videoRef.set(video);
    return res.status(201).json({ ok: true, video });
  } catch {
    return res.status(500).json({ ok: false, error: "Could not publish the video." });
  }
});

app.get("/api/media/videos", async (req, res) => {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const type = String(req.query.type || "").trim().toLowerCase();
  try {
    const snapshot = await db.ref("videos").orderByChild("createdAt").limitToLast(100).get();
    let videos = Object.values(snapshot.val() || {})
      .filter((item) => item && (item.secureUrl || item.videoUrl))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (type === "video" || type === "reel") {
      videos = videos.filter((item) => (item.mediaType || "video") === type);
    }
    return res.json({ ok: true, videos: videos.slice(0, limit) });
  } catch {
    return res.status(500).json({ ok: false, error: "Could not load videos." });
  }
});
