import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

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
const db = app ? getDatabaseWithUrl(process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com", app) : null;

function validUserId(value) {
  return /^[a-z0-9._-]{1,50}$/.test(String(value || "").trim().toLowerCase().replace(/^@+/, ""));
}

function userIdKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\./g, "%2E")
    .replace(/#/g, "%23")
    .replace(/\$/g, "%24")
    .replace(/\//g, "%2F")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D");
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

const originalRouterFactory = express.Router;
express.Router = function guardedRouter(...args) {
  const router = originalRouterFactory(...args);
  const originalGet = router.get.bind(router);
  router.get = function guardedGet(path, ...handlers) {
    if (path === "/account/profile/:identifier") {
      return originalGet(path, protectProfileIdentifier, ...handlers);
    }
    return originalGet(path, ...handlers);
  };
  return router;
};
