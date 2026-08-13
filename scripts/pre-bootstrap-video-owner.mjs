import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { saveCanonicalVideo } from "../services/canonical-content.js";
import { canonicalUserRoot } from "../services/user-canonical.js";

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

const app = initFirebase();
const db = app ? getDatabaseWithUrl(process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com", app) : null;
const originalPost = express.application.post;

express.application.post = function preBootstrapVideoOwner(path, ...handlers) {
  if (path !== "/api/media/videos") return originalPost.call(this, path, ...handlers);
  const saveVideo = async (req, res) => {
    if (!db || !app) return res.status(503).json({ ok: false, error: "Firebase database is unavailable." });
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return res.status(401).json({ ok: false, error: "Authentication required." });
    let user;
    try { user = await admin.auth(app).verifyIdToken(header.slice(7)); }
    catch { return res.status(401).json({ ok: false, error: "Invalid authentication token." }); }

    const mediaType = req.body?.mediaType === "reel" ? "reel" : "video";
    const publicId = String(req.body?.publicId || "").trim();
    const secureUrl = String(req.body?.secureUrl || "").trim();
    const title = String(req.body?.title || "").trim().slice(0, 120);
    const caption = String(req.body?.caption || "").trim().slice(0, 500);
    if (!publicId || !secureUrl || !/^https:\/\//i.test(secureUrl)) return res.status(400).json({ ok: false, error: "Uploaded video could not be published." });

    try {
      const userData = (await db.ref(`users/${user.uid}`).get()).val() || {};
      const profile = userData.profile || {};
      const userId = String(profile.userId || userData.userId || profile.username || userData.username || user.email?.split("@")[0] || `user_${user.uid.slice(0, 8)}`).replace(/^@/, "").trim();
      const name = String(profile.name || profile.displayName || userData.name || user.displayName || userId || "Indo User").trim();
      const creator = `@${userId}`;
      const avatarUrl = String(profile.photoURL || profile.avatarUrl || userData.photoURL || userData.avatarUrl || "").trim();
      const videoRef = db.ref("videos").push();
      const video = {
        id: videoRef.key, mediaType, ownerUid: user.uid, userId, creator, creatorName: name, creatorAvatar: avatarUrl,
        title: title || (mediaType === "reel" ? "Untitled reel" : "Untitled video"), caption, publicId, secureUrl, videoUrl: secureUrl,
        duration: Number(req.body?.duration || 0), width: Number(req.body?.width || 0), height: Number(req.body?.height || 0), views: 0, likes: 0, createdAt: Date.now(),
      };
      await videoRef.set(video);
      await saveCanonicalVideo({ db, uid: user.uid, video });
      await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => (Number(current) || 0) + 1);
      await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => (Number(current) || 0) + 1);
      console.log(`[video-save] saved ${video.id} for ${user.uid} as ${creator}`);
      return res.status(201).json({ ok: true, video });
    } catch (error) {
      console.error("Video save failed:", error);
      return res.status(500).json({ ok: false, error: "Could not publish the video.", detail: String(error?.message || error || "Unknown error") });
    }
  };
  return originalPost.call(this, path, saveVideo);
};

await import("./force-canonical-bootstrap.mjs");
