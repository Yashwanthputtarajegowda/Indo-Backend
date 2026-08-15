import express from "express";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  const databaseURL =
    process.env.FIREBASE_DATABASE_URL ||
    "https://indo-174f0-default-rtdb.firebaseio.com";
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL,
  });
}

const firebaseApp = initFirebase();
const auth = firebaseApp ? admin.auth(firebaseApp) : null;
const db = firebaseApp
  ? getDatabaseWithUrl(
      process.env.FIREBASE_DATABASE_URL ||
        "https://indo-174f0-default-rtdb.firebaseio.com",
      firebaseApp,
    )
  : null;

const legacyViewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many view requests. Please try again later." },
});

const mediaSignatureLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many upload-signature requests. Please try again later." },
});

function normalizeUsername(value) {
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

function validUsername(username) {
  return /^[a-z0-9._-]{1,50}$/.test(username);
}

function validUid(uid) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(uid);
}

async function verifyBearer(req) {
  if (!auth) return null;
  const header = String(req.headers.authorization || "");
  if (!/^Bearer\s+\S+$/i.test(header)) return null;
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token.length < 20 || token.length > 16384) return null;
  try {
    return await auth.verifyIdToken(token, true);
  } catch {
    return null;
  }
}

async function canViewPrivateProfile(targetUid, viewerUid) {
  if (!db || !viewerUid) return false;
  if (String(targetUid) === String(viewerUid)) return true;
  const followingSnapshot = await db
    .ref(`users/${targetUid}/followers/${viewerUid}`)
    .get();
  return followingSnapshot.exists();
}

async function protectPrivateProfileByUid(req, res, next) {
  if (!db)
    return res.status(503).json({ ok: false, error: "Service unavailable." });

  const uid = String(req.params.uid || "").trim();
  if (!validUid(uid))
    return res.status(400).json({ ok: false, error: "Invalid profile UID." });

  try {
    const profileSnapshot = await db.ref(`users/${uid}`).get();
    if (!profileSnapshot.exists())
      return res.status(404).json({ ok: false, error: "Profile not found." });

    const profile = profileSnapshot.val() || {};
    const canonicalProfile =
      profile.profile && typeof profile.profile === "object"
        ? profile.profile
        : profile;
    const accountType =
      canonicalProfile.accountType === "private" ||
      profile.accountType === "private" ||
      profile.settings?.accountType === "private"
        ? "private"
        : "public";

    if (accountType !== "private") return next();

    const viewer = await verifyBearer(req);
    if (!viewer)
      return res.status(401).json({ ok: false, error: "Authentication required for private profiles." });

    if (!(await canViewPrivateProfile(uid, viewer.uid)))
      return res.status(403).json({ ok: false, error: "Private profile content is not available." });

    req.securityProfileViewer = viewer;
    return next();
  } catch {
    return res.status(500).json({ ok: false, error: "Could not validate profile access." });
  }
}

async function protectPrivatePublicProfile(req, res, next) {
  if (!db)
    return res.status(503).json({ ok: false, error: "Service unavailable." });

  const username = normalizeUsername(req.params.username);
  if (!validUsername(username))
    return res.status(400).json({ ok: false, error: "Invalid User ID." });

  try {
    const claimSnapshot = await db
      .ref(`usernames/${userIdKey(username)}`)
      .get();
    if (!claimSnapshot.exists() || !claimSnapshot.val()?.uid)
      return res.status(404).json({ ok: false, error: "Profile not found." });

    const targetUid = String(claimSnapshot.val().uid);
    const profileSnapshot = await db.ref(`users/${targetUid}`).get();
    if (!profileSnapshot.exists())
      return res.status(404).json({ ok: false, error: "Profile not found." });

    const profile = profileSnapshot.val() || {};
    const canonicalProfile =
      profile.profile && typeof profile.profile === "object"
        ? profile.profile
        : profile;
    const accountType =
      canonicalProfile.accountType === "private" ||
      profile.accountType === "private" ||
      profile.settings?.accountType === "private"
        ? "private"
        : "public";

    if (accountType !== "private") return next();

    const viewer = await verifyBearer(req);
    if (!viewer)
      return res.status(401).json({ ok: false, error: "Authentication required for private profiles." });

    if (!(await canViewPrivateProfile(targetUid, viewer.uid)))
      return res.status(403).json({ ok: false, error: "Private profile content is not available." });

    req.securityProfileViewer = viewer;
    return next();
  } catch {
    return res.status(500).json({ ok: false, error: "Could not validate profile access." });
  }
}

const originalPost = express.application.post;
express.application.post = function securePost(path, ...handlers) {
  if (path === "/api/media/videos/:videoId/view") {
    const guard = async (req, res, next) => {
      if (!auth)
        return res.status(503).json({ ok: false, error: "Authentication service is unavailable." });
      const header = String(req.headers.authorization || "");
      if (!/^Bearer\s+\S+$/i.test(header))
        return res.status(401).json({ ok: false, error: "Authentication required." });
      const token = header.replace(/^Bearer\s+/i, "").trim();
      if (token.length < 20 || token.length > 16384)
        return res.status(401).json({ ok: false, error: "Invalid authentication token." });
      try {
        req.securityUser = await auth.verifyIdToken(token, true);
      } catch {
        return res.status(401).json({ ok: false, error: "Invalid or expired authentication token." });
      }
      return next();
    };
    return originalPost.call(this, path, legacyViewLimiter, guard, ...handlers);
  }

  if (path === "/api/media/signature") {
    const guard = async (req, res, next) => {
      if (!auth)
        return res.status(503).json({ ok: false, error: "Authentication service is unavailable." });
      const header = String(req.headers.authorization || "");
      if (!/^Bearer\s+\S+$/i.test(header))
        return res.status(401).json({ ok: false, error: "Authentication required." });
      const token = header.replace(/^Bearer\s+/i, "").trim();
      if (token.length < 20 || token.length > 16384)
        return res.status(401).json({ ok: false, error: "Invalid authentication token." });
      try {
        req.securityUser = await auth.verifyIdToken(token, true);
      } catch {
        return res.status(401).json({ ok: false, error: "Invalid or expired authentication token." });
      }
      return next();
    };
    return originalPost.call(this, path, mediaSignatureLimiter, guard, ...handlers);
  }

  return originalPost.call(this, path, ...handlers);
};

const originalGet = express.application.get;
express.application.get = function secureGet(path, ...handlers) {
  if (path === "/api/account/profile/:username") {
    return originalGet.call(this, path, protectPrivatePublicProfile, ...handlers);
  }
  if (path === "/api/account/public-profile/:uid") {
    return originalGet.call(this, path, protectPrivateProfileByUid, ...handlers);
  }
  return originalGet.call(this, path, ...handlers);
};
