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
    databaseURL:
      process.env.FIREBASE_DATABASE_URL ||
      "https://indo-174f0-default-rtdb.firebaseio.com",
  });
}

const firebaseApp = initFirebase();
const db = firebaseApp
  ? getDatabaseWithUrl(
      process.env.FIREBASE_DATABASE_URL ||
        "https://indo-174f0-default-rtdb.firebaseio.com",
      firebaseApp,
    )
  : null;
const auth = firebaseApp ? admin.auth(firebaseApp) : null;

function normalizeUserId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
}

function validUserId(userId) {
  return /^[a-z0-9._-]{1,50}$/.test(userId);
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

async function verifyBearer(req, res) {
  if (!auth) {
    res.status(503).json({
      ok: false,
      error: "Firebase Admin is not configured on the backend.",
    });
    return null;
  }
  const header = String(req.headers.authorization || "");
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

const originalPatch = express.application.patch;
if (originalPatch && db) {
  express.application.patch = function signupCanonicalProfilePatch(
    path,
    ...handlers
  ) {
    if (path !== "/api/account/profile")
      return originalPatch.call(this, path, ...handlers);
    const handler = async (req, res) => {
      const user = await verifyBearer(req, res);
      if (!user) return;
      const uid = String(user.uid || "").trim();
      const userId = normalizeUserId(req.body?.userId);
      const name = String(req.body?.name || "")
        .trim()
        .slice(0, 120);
      const bio = String(req.body?.bio || "")
        .trim()
        .slice(0, 160);
      if (!uid)
        return res.status(400).json({ ok: false, error: "User is required." });
      if (!validUserId(userId))
        return res.status(400).json({ ok: false, error: "Invalid User ID." });
      if (!name)
        return res
          .status(400)
          .json({ ok: false, error: "User Name is required." });
      try {
        const usersSnapshot = await db.ref("users").get();
        const users = usersSnapshot.val() || {};
        for (const [otherUid, other] of Object.entries(users)) {
          if (String(otherUid) === uid) continue;
          const otherId = normalizeUserId(
            other?.profile?.userId ||
              other?.profile?.username ||
              other?.userId ||
              other?.username ||
              "",
          );
          if (otherId && otherId === userId) {
            return res
              .status(409)
              .json({ ok: false, error: `@${userId} is already taken.` });
          }
        }

        const userRef = db.ref(`users/${uid}`);
        const previous = (await userRef.get()).val() || {};
        const previousProfile = previous.profile || {};
        const profile = {
          ...previousProfile,
          uid,
          userId,
          username: `@${userId}`,
          name,
          displayName: name,
          bio,
          accountType:
            String(
              req.body?.accountType ||
                previousProfile.accountType ||
                previous.accountType ||
                "public",
            ) === "private"
              ? "private"
              : "public",
          updatedAt: Date.now(),
        };
        const profilePrivate = {
          ...(previous.profilePrivate || {}),
          email:
            user.email ||
            previous.profilePrivate?.email ||
            previous.email ||
            "",
        };
        const updates = {
          [`users/${uid}/profile`]: profile,
          [`users/${uid}/profilePrivate`]: profilePrivate,
          [`users/${uid}/name`]: name,
          [`users/${uid}/userId`]: `@${userId}`,
          [`users/${uid}/username`]: `@${userId}`,
          [`users/${uid}/accountType`]: profile.accountType,
          [`users/${uid}/updatedAt`]: Date.now(),
          [`usernames/${userIdKey(userId)}`]: {
            uid,
            username: `@${userId}`,
            updatedAt: Date.now(),
          },
        };
        await db.ref().update(updates);
        return res.json({ ok: true, profile });
      } catch (error) {
        console.error("Canonical signup profile claim failed:", error);
        return res.status(500).json({
          ok: false,
          error: "Could not create the Indo profile.",
          detail: String(error?.message || error || "Unknown error"),
        });
      }
    };
    return originalPatch.call(this, path, handler);
  };
}

await import("./signup-availability-bootstrap.mjs");
