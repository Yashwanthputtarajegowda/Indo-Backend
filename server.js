import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import {
  createCloudinarySignature,
  getCloudinaryConfig,
  destroyCloudinaryVideo,
} from "./services/cloudinary-signature.js";
import { cleanupInactiveAccounts } from "./services/account-cleanup.js";
import { deleteAccountData } from "./services/account-delete.js";
import { toggleFollow, getFollowStatus } from "./services/social-follow.js";
import {
  canonicalUserRoot,
  migrateAllUsersToCanonical,
  syncCanonicalUser,
} from "./services/user-canonical.js";
import {
  saveCanonicalVideo,
  updateCanonicalVideoViews,
  deleteCanonicalVideo,
  saveCanonicalStory,
  deleteCanonicalStory,
} from "./services/canonical-content.js";
import { createAccountContactRouter } from "./routes/account-contact.js";
import { createAccountVisibilityRouter } from "./routes/account-visibility.js";
import { createAccountClaimRouter } from "./routes/account-claim.js";
import { createCanonicalMediaEngagementRouter } from "./routes/media-engagement-canonical.js";
import { createSocialBlockRouter } from "./routes/social-block.js";
import { createEarningsRouter } from "./routes/earnings.js";
import { createMessagesRouter } from "./routes/messages.js";
import { createFollowRequestsRouter } from "./routes/follow-requests.js";
import { createNotificationsRouter } from "./routes/notifications.js";

const app = express();
const PORT = process.env.PORT || 3001;
const DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  "https://indo-174f0-default-rtdb.firebaseio.com";
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BACKEND_VERSION = "20260815-security-v2";
const CANONICAL_SCHEMA_VERSION = 3;
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
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: "2mb", strict: true }));
app.use((req, res, next) => {
  res.setHeader("X-Indo-Backend-Version", BACKEND_VERSION);
  res.setHeader("Cache-Control", "no-store");
  next();
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests. Please try again later." },
});
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many authentication requests. Please try again later." },
});
app.use("/api", apiLimiter);

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    app: "Indo-Backend",
    backendVersion: BACKEND_VERSION,
    canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
    firebaseAdmin: Boolean(firebaseAdmin),
    databaseConfigured: Boolean(db),
  }),
);

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
function mediaFolder(uid, kind) {
  const safeUid = String(uid || "").trim();
  return kind === "story" ? `indo/stories/${safeUid}` : `indo/videos/${safeUid}`;
}
function isSafeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}
function isCloudinarySecureUrl(value) {
  if (!isSafeHttpUrl(value)) return false;
  try {
    const parsed = new URL(value);
    const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
    if (!cloudName) return false;
    return parsed.hostname === `${cloudName}.res.cloudinary.com` &&
      parsed.pathname.startsWith("/");
  } catch {
    return false;
  }
}
function isUserMediaPublicId(publicId, uid, kind) {
  const value = String(publicId || "").trim().replace(/^\/+/, "");
  if (!value || value.length > 500 || value.includes("..")) return false;
  if (/%2f|%2e|%5c/i.test(value)) return false;
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) return false;
  return value.startsWith(`${mediaFolder(uid, kind)}/`);
}

async function requireUser(req, res) {
  if (!auth) {
    res.status(503).json({ ok: false, error: "Authentication service is unavailable." });
    return null;
  }
  const header = String(req.headers.authorization || "");
  if (!/^Bearer\s+\S+$/i.test(header)) {
    res.status(401).json({ ok: false, error: "Authentication required." });
    return null;
  }
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token.length < 20 || token.length > 16384) {
    res.status(401).json({ ok: false, error: "Invalid authentication token." });
    return null;
  }
  try {
    return await auth.verifyIdToken(token, true);
  } catch {
    res.status(401).json({ ok: false, error: "Invalid or expired authentication token." });
    return null;
  }
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

app.post("/api/media/signature", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const kind = String(req.body?.kind || "video").trim().toLowerCase();
  if (kind !== "video" && kind !== "story")
    return res.status(400).json({ ok: false, error: "Invalid media type." });
  const folder = mediaFolder(user.uid, kind);
  try {
    return res.json({
      ok: true,
      ...getCloudinaryConfig(),
      timestamp,
      folder,
      signature: createCloudinarySignature(timestamp, {
        folder,
        resource_type: kind === "story" ? "image" : "video",
      }),
    });
  } catch {
    return res
      .status(503)
      .json({ ok: false, error: "Media upload is temporarily unavailable." });
  }
});

app.post("/api/media/videos", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!db)
    return res.status(503).json({ ok: false, error: "Service unavailable." });
  const mediaType = req.body?.mediaType === "reel" ? "reel" : "video";
  const publicId = String(req.body?.publicId || "").trim();
  const secureUrl = String(req.body?.secureUrl || "").trim();
  const title = String(req.body?.title || "").trim().slice(0, 120);
  const caption = String(req.body?.caption || "").trim().slice(0, 500);
  const duration = Number(req.body?.duration || 0);
  const width = Number(req.body?.width || 0);
  const height = Number(req.body?.height || 0);
  if (
    !publicId ||
    !isUserMediaPublicId(publicId, user.uid, "video") ||
    !isCloudinarySecureUrl(secureUrl) ||
    !Number.isFinite(duration) || duration < 0 || duration > 60 * 60 ||
    !Number.isFinite(width) || width < 0 || width > 20000 ||
    !Number.isFinite(height) || height < 0 || height > 20000
  )
    return res
      .status(400)
      .json({ ok: false, error: "Uploaded video could not be published." });
  try {
    const profile = (
      await syncCanonicalUser({ db, uid: user.uid, includeContent: false })
    ).profile;
    const videoRef = db.ref("videos").push();
    const video = {
      id: videoRef.key,
      mediaType,
      ownerUid: user.uid,
      creator: profile.username || `@${user.uid.slice(0, 8)}`,
      creatorName: profile.name || "Indo User",
      title:
        title || (mediaType === "reel" ? "Untitled reel" : "Untitled video"),
      caption,
      publicId,
      secureUrl,
      videoUrl: secureUrl,
      duration,
      width,
      height,
      views: 0,
      likes: 0,
      createdAt: admin.database.ServerValue.TIMESTAMP,
    };
    await videoRef.set(video);
    await saveCanonicalVideo({
      db,
      uid: user.uid,
      video: { ...video, createdAt: Date.now() },
    });
    await db
      .ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`)
      .transaction((current) => (Number(current) || 0) + 1);
    await db
      .ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`)
      .transaction((current) => (Number(current) || 0) + 1);
    return res.status(201).json({ ok: true, video });
  } catch {
    return res
      .status(500)
      .json({ ok: false, error: "Could not publish the video." });
  }
});

app.get("/api/media/videos", async (req, res) => {
  if (!db)
    return res.status(503).json({ ok: false, error: "Service unavailable." });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const type = String(req.query.type || "").trim().toLowerCase();
  try {
    const snapshot = await db.ref("videos").get();
    let videos = Object.values(snapshot.val() || {})
      .filter((item) => {
        if (!item) return false;
        const telegramFileId = String(
          item?.telegram?.fileId || item?.telegramStorage?.fileId || "",
        ).trim();
        return Boolean(item.secureUrl || item.videoUrl || item.url || telegramFileId);
      })
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    if (type === "video" || type === "reel")
      videos = videos.filter((item) => (item.mediaType || "video") === type);

    const host = String(req.get("host") || "").trim();
    const protocol = req.protocol || "https";
    videos = videos.slice(0, limit).map((video) => {
      const telegramFileId = String(
        video?.telegram?.fileId || video?.telegramStorage?.fileId || "",
      ).trim();
      if (telegramFileId && video.id && host) {
        const streamUrl = `${protocol}://${host}/api/media/videos/${encodeURIComponent(video.id)}/stream`;
        return {
          ...video,
          secureUrl: streamUrl,
          videoUrl: streamUrl,
          telegramPlayback: streamUrl,
        };
      }
      return video;
    });

    return res.json({ ok: true, videos });
  } catch {
    return res.status(500).json({ ok: false, error: "Could not load videos." });
  }
});

app.post("/api/media/videos/:videoId/view", async (req, res) => {
  if (!db)
    return res.status(503).json({ ok: false, error: "Service unavailable." });
  const videoId = String(req.params.videoId || "").trim();
  if (!videoId)
    return res.status(400).json({ ok: false, error: "Video ID is required." });
  try {
    const videoRef = db.ref(`videos/${videoId}`);
    const snapshot = await videoRef.get();
    if (!snapshot.exists())
      return res.status(404).json({ ok: false, error: "Video not found." });
    const video = snapshot.val() || {};
    const result = await videoRef
      .child("views")
      .transaction((current) => (Number(current) || 0) + 1);
    await updateCanonicalVideoViews({
      db,
      uid: video.ownerUid,
      videoId,
      views: Number(result.snapshot.val()) || 0,
    });
    return res.json({
      ok: true,
      videoId,
      views: Number(result.snapshot.val()) || 0,
    });
  } catch {
    return res
      .status(500)
      .json({ ok: false, error: "Could not record video view." });
  }
});

app.post("/api/media/videos/:videoId/delete", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!db)
    return res.status(503).json({ ok: false, error: "Service unavailable." });
  const videoId = String(req.params.videoId || "").trim();
  if (!videoId)
    return res.status(400).json({ ok: false, error: "Video ID is required." });
  try {
    const videoRef = db.ref(`videos/${videoId}`);
    const snapshot = await videoRef.get();
    if (!snapshot.exists())
      return res.json({
        ok: true,
        videoId,
        alreadyDeleted: true,
        cloudinaryDeleted: false,
      });
    const video = snapshot.val() || {};
    if (String(video.ownerUid || "") !== String(user.uid || ""))
      return res
        .status(403)
        .json({ ok: false, error: "You can delete only your own video." });
    await videoRef.remove();
    await deleteCanonicalVideo({ db, uid: user.uid, videoId });
    await db
      .ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`)
      .transaction((current) => Math.max(0, (Number(current) || 0) - 1));
    await db
      .ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`)
      .transaction((current) => Math.max(0, (Number(current) || 0) - 1));
    let cloudinaryDeleted = false;
    if (video.publicId) {
      try {
        const result = await destroyCloudinaryVideo(video.publicId);
        cloudinaryDeleted = result?.result !== "error";
      } catch (error) {
        console.warn(
          "Cloudinary video delete failed:",
          String(error?.message || error || "unknown error"),
        );
      }
    }
    return res.json({ ok: true, videoId, deleted: true, cloudinaryDeleted });
  } catch {
    return res.status(500).json({ ok: false, error: "Could not delete video." });
  }
});

app.post("/api/stories", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!db)
    return res.status(503).json({ ok: false, error: "Service unavailable." });
  const publicId = String(req.body?.publicId || "").trim();
  const secureUrl = String(req.body?.secureUrl || "").trim();
  if (
    !publicId ||
    !isUserMediaPublicId(publicId, user.uid, "story") ||
    !isCloudinarySecureUrl(secureUrl)
  )
    return res.status(400).json({ ok: false, error: "Invalid story media." });
  return res.status(501).json({ ok: false, error: "Story publishing is unchanged." });
});

app.listen(PORT, () => {
  console.log(`Indo-Backend listening on port ${PORT}`);
});
