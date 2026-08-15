import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com",
  });
}

const firebaseApp = initFirebase();
const db = firebaseApp ? getDatabaseWithUrl(process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com", firebaseApp) : null;

const probeRouter = express.Router();
const originalRouterPost = express.Router.prototype.post || probeRouter.post;

function normalizeUserId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

function validUserId(userId) {
  return /^[a-z0-9._-]{1,50}$/.test(userId);
}

function extractUserId(user = {}) {
  return normalizeUserId(user?.profile?.userId || user?.profile?.username || user?.userId || user?.username || "");
}

if (express.Router.prototype?.post) {
  express.Router.prototype.post = function signupAvailabilityRouterPost(path, ...handlers) {
    if (path === "/account/check-user-id") {
      const handler = async (req, res) => {
        if (!db) return res.status(503).json({ ok: false, error: "Firebase database is unavailable." });
        const userId = normalizeUserId(req.body?.userId);
        if (!validUserId(userId)) return res.status(400).json({ ok: false, error: "Invalid User ID." });
        try {
          // Canonical schema source-of-truth: users/{uid}/profile.userId.
          // Read the user collection and compare against the canonical profile value.
          const snapshot = await db.ref("users").get();
          const users = snapshot.val() || {};
          const taken = Object.values(users).some((user) => extractUserId(user) === userId);
          return res.json({ ok: true, available: !taken, userId });
        } catch (error) {
          console.error("User ID availability check failed:", error);
          return res.status(500).json({
            ok: false,
            error: "Could not check User ID. Please try again.",
          });
        }
      };
      return originalRouterPost.call(this, path, handler);
    }
    return originalRouterPost.call(this, path, ...handlers);
  };
}

await import("./pre-bootstrap-video-owner.mjs");
