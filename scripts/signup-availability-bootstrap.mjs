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
const db = firebaseApp
  ? getDatabaseWithUrl(process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com", firebaseApp)
  : null;

const originalPost = express.application.post;

function normalizeUserId(value) {
  return String(value || "").trim().toLowerCase().replace(/^@/, "");
}

function userIdKey(userId) {
  return String(userId || "")
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

express.application.post = function signupAvailabilityBootstrap(path, ...handlers) {
  if (path === "/api/account/check-user-id") {
    const handler = async (req, res) => {
      if (!db) return res.status(503).json({ ok: false, error: "Firebase database is unavailable." });
      const userId = normalizeUserId(req.body?.userId);
      if (!validUserId(userId)) {
        return res.status(400).json({ ok: false, error: "Invalid User ID." });
      }
      try {
        const snapshot = await db.ref(`usernames/${userIdKey(userId)}`).get();
        return res.json({ ok: true, available: !snapshot.exists(), userId });
      } catch (error) {
        console.error("User ID availability check failed:", error);
        return res.status(500).json({ ok: false, error: "Could not check User ID. Please try again." });
      }
    };
    return originalPost.call(this, path, handler);
  }
  return originalPost.call(this, path, ...handlers);
};

await import("./pre-bootstrap-video-owner.mjs");
