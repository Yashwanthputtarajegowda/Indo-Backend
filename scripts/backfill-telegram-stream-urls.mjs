import "dotenv/config";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";
const PUBLIC_BACKEND_URL = String(
  process.env.PUBLIC_BACKEND_URL || "https://indo-backend-production-41b1.up.railway.app",
).replace(/\/$/, "");

function getFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) throw new Error("Firebase admin credentials are missing.");
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL: DATABASE_URL,
  });
}

const app = getFirebase();
const db = getDatabaseWithUrl(DATABASE_URL, app);
const snapshot = await db.ref("videos").get();
const videos = snapshot.val() || {};
let updated = 0;
let skipped = 0;

for (const [videoId, video] of Object.entries(videos)) {
  const telegramFileId = String(video?.telegram?.fileId || video?.telegramStorage?.fileId || "").trim();
  if (!telegramFileId) {
    skipped += 1;
    continue;
  }

  const streamUrl = `${PUBLIC_BACKEND_URL}/api/media/videos/${encodeURIComponent(videoId)}/stream`;
  await db.ref(`videos/${videoId}`).update({
    secureUrl: streamUrl,
    videoUrl: streamUrl,
    telegramPlayback: streamUrl,
  });
  updated += 1;
}

console.log(`Telegram stream URL backfill complete. updated=${updated} skipped=${skipped}`);
