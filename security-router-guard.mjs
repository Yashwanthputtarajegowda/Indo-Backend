import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

const MAX_AUTH_AGE_SECONDS = 15 * 60;

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  const databaseURL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL,
  });
}

const app = initFirebase();
const auth = app ? admin.auth(app) : null;
const db = app
  ? getDatabaseWithUrl(
      process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com",
      app,
    )
  : null;

function normalizedUserId(value) {
  return String(value || "").trim().toLowerCase().replace(/^@+/, "");
}

function validUserId(value) {
  return /^[a-z0-9._-]{1,50}$/.test(normalizedUserId(value));
}

function validUid(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(String(value || "").trim());
}

function userIdKey(value) {
  return normalizedUserId(value)
    .replace(/\./g, "%2E")
    .replace(/#/g, "%23")
    .replace(/\$/g, "%24")
    .replace(/\//g, "%2F")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D");
}

function isSafeText(value, max) {
  const text = String(value ?? "");
  if (text.length > max) return false;
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
}

function isHttpsUrl(value, max = 1200) {
  const raw = String(value || "").trim();
  if (!raw) return true;
  if (raw.length > max || /[\u0000-\u001F\u007F]/.test(raw)) return false;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
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

async function verifyRecentBearer(req) {
  const user = await verifyBearer(req);
  if (!user) return null;
  const authTime = Number(user.auth_time || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authTime || now - authTime > MAX_AUTH_AGE_SECONDS) return null;
  return user;
}

async function canViewPrivate(targetUid, viewerUid) {
  if (!db || !viewerUid) return false;
  if (String(targetUid) === String(viewerUid)) return true;
  const snap = await db.ref(`users/${targetUid}/followers/${viewerUid}`).get();
  return snap.exists();
}

async function protectProfileIdentifier(req, res, next) {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const identifier = String(req.params.identifier || "").trim();
  if (!identifier || !validUserId(identifier)) return res.status(400).json({ ok: false, error: "Invalid User ID." });

  try {
    const claim = await db.ref(`usernames/${userIdKey(identifier)}`).get();
    if (!claim.exists() || !claim.val()?.uid) return res.status(404).json({ ok: false, error: "Profile not found." });
    const targetUid = String(claim.val().uid);
    const profileSnap = await db.ref(`users/${targetUid}`).get();
    if (!profileSnap.exists()) return res.status(404).json({ ok: false, error: "Profile not found." });
    const value = profileSnap.val() || {};
    const profile = value.profile && typeof value.profile === "object" ? value.profile : value;
    const accountType = profile.accountType === "private" || value.accountType === "private" || value.settings?.accountType === "private" ? "private" : "public";
    if (accountType !== "private") return next();

    const viewer = await verifyBearer(req);
    if (!viewer) return res.status(401).json({ ok: false, error: "Authentication required for private profiles." });
    if (!(await canViewPrivate(targetUid, viewer.uid))) return res.status(403).json({ ok: false, error: "Private profile content is not available." });
    req.securityProfileViewer = viewer;
    return next();
  } catch {
    return res.status(500).json({ ok: false, error: "Could not validate profile access." });
  }
}

async function protectPublicProfileByUid(req, res, next) {
  if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
  const targetUid = String(req.params.uid || "").trim();
  if (!validUid(targetUid)) return res.status(400).json({ ok: false, error: "Invalid profile UID." });
  try {
    const snap = await db.ref(`users/${targetUid}`).get();
    if (!snap.exists()) return res.status(404).json({ ok: false, error: "Profile not found." });
    const value = snap.val() || {};
    const profile = value.profile && typeof value.profile === "object" ? value.profile : value;
    const privateProfile = profile.accountType === "private" || value.accountType === "private" || value.settings?.accountType === "private";
    if (!privateProfile) return next();
    const viewer = await verifyBearer(req);
    if (!viewer) return res.status(401).json({ ok: false, error: "Authentication required for private profiles." });
    if (!(await canViewPrivate(targetUid, viewer.uid))) return res.status(403).json({ ok: false, error: "Private profile content is not available." });
    req.securityProfileViewer = viewer;
    return next();
  } catch {
    return res.status(500).json({ ok: false, error: "Could not validate profile access." });
  }
}

function protectProfileUpdate(req, res, next) {
  const body = req.body || {};
  if (
    !isSafeText(body.name, 80) ||
    !isSafeText(body.bio, 160) ||
    !isSafeText(body.location, 100) ||
    !isSafeText(body.role, 60) ||
    !isSafeText(body.interests, 240) ||
    !isSafeText(body.language, 40)
  ) {
    return res.status(400).json({ ok: false, error: "Profile contains invalid characters or is too long." });
  }
  if (!isHttpsUrl(body.website, 1200)) {
    return res.status(400).json({ ok: false, error: "Invalid website URL." });
  }
  if (body.avatarUrl && !isHttpsUrl(body.avatarUrl, 1200)) {
    return res.status(400).json({ ok: false, error: "Invalid profile photo URL." });
  }
  return next();
}

async function protectSensitiveAccountMutation(req, res, next) {
  const user = await verifyRecentBearer(req);
  if (!user) return res.status(401).json({ ok: false, error: "Recent authentication is required. Please sign in again." });
  req.securityRecentAuthUser = user;
  return next();
}

const originalRouterFactory = express.Router;
express.Router = function guardedRouter(...args) {
  const router = originalRouterFactory(...args);

  const originalGet = router.get.bind(router);
  router.get = function guardedGet(path, ...handlers) {
    if (path === "/account/profile/:identifier") {
      return originalGet(path, protectProfileIdentifier, ...handlers);
    }
    if (path === "/account/public-profile/:uid") {
      return originalGet(path, protectPublicProfileByUid, ...handlers);
    }
    return originalGet(path, ...handlers);
  };

  const originalPatch = router.patch.bind(router);
  router.patch = function guardedPatch(path, ...handlers) {
    if (path === "/account/profile") {
      return originalPatch(path, protectProfileUpdate, ...handlers);
    }
    if (path === "/account/contact") {
      return originalPatch(path, protectSensitiveAccountMutation, ...handlers);
    }
    return originalPatch(path, ...handlers);
  };

  return router;
};
