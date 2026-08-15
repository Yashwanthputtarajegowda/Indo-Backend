import admin from "firebase-admin";
import express from "express";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { migrateAllUsersToCanonical } from "../services/user-canonical.js";

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

const app = initFirebase();
const db = app
  ? getDatabaseWithUrl(
      process.env.FIREBASE_DATABASE_URL ||
        "https://indo-174f0-default-rtdb.firebaseio.com",
      app,
    )
  : null;

if (!app || !db) {
  console.error(
    "[canonical-migration] Firebase Admin credentials are missing; migration skipped.",
  );
} else {
  const version = Number(
    (await db.ref("system/canonicalSchemaVersion/version").get()).val() || 0,
  );
  if (version < 3) {
    const result = await migrateAllUsersToCanonical({ db });
    console.log(
      `[canonical-migration] migrated ${result.users} users to version 3`,
    );
  } else {
    console.log(`[canonical-migration] version ${version} already active`);
  }
}

// Railway can still start an older production entrypoint. Replace the fragile
// /api/stories handler at the Express prototype level so story publishing is
// independent of an already-migrated profile branch.
const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  if (path !== "/api/stories")
    return originalPost.call(this, path, ...handlers);

  const saveStory = async (req, res) => {
    if (!db)
      return res
        .status(503)
        .json({ ok: false, error: "Firebase database is unavailable." });
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer "))
      return res
        .status(401)
        .json({ ok: false, error: "Authentication required." });
    let user;
    try {
      user = await admin.auth(app).verifyIdToken(header.slice(7));
    } catch {
      return res
        .status(401)
        .json({ ok: false, error: "Invalid authentication token." });
    }

    const publicId = String(req.body?.publicId || "").trim();
    const secureUrl = String(req.body?.secureUrl || "").trim();
    if (!publicId || !secureUrl) {
      return res
        .status(400)
        .json({ ok: false, error: "Uploaded story data is required." });
    }

    try {
      const userSnapshot = await db.ref(`users/${user.uid}`).get();
      const userData = userSnapshot.val() || {};
      const profile = userData.profile || {};
      const username = String(
        profile.username ||
          userData.username ||
          userData.userId ||
          user.email?.split("@")[0] ||
          "User",
      );
      const name = String(
        profile.name ||
          userData.name ||
          user.displayName ||
          username ||
          "Indo User",
      );
      const ref = db.ref("stories").push();
      const story = {
        id: ref.key,
        ownerUid: user.uid,
        username,
        name,
        publicId,
        secureUrl,
        title: String(req.body?.title || "")
          .trim()
          .slice(0, 80),
        titleFont: String(req.body?.titleFont || "Arial, sans-serif").slice(
          0,
          160,
        ),
        titleX: Number(req.body?.titleX ?? 50),
        titleY: Number(req.body?.titleY ?? 14),
        crop: String(req.body?.crop || "portrait").slice(0, 20),
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };

      await db.ref().update({
        [`stories/${ref.key}`]: story,
        [`users/${user.uid}/content/stories/${ref.key}`]: story,
      });
      await db
        .ref(`users/${user.uid}/stats/storiesCount`)
        .transaction((current) => (Number(current) || 0) + 1);
      console.log(`[story-save] saved ${ref.key} for ${user.uid}`);
      return res.status(201).json({ ok: true, story });
    } catch (error) {
      console.error("Story save failed:", error);
      return res.status(500).json({
        ok: false,
        error: "Could not save story.",
        detail: String(error?.message || error || "Unknown error"),
      });
    }
  };

  return originalPost.call(this, path, saveStory);
};

await import("../server.js");
