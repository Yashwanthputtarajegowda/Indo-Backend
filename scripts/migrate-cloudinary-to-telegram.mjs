import "dotenv/config";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { mirrorVideoFromUrl, telegramStorageConfigured } from "../services/telegram-storage.js";

const DATABASE_URL = String(
  process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com",
).trim();

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = String(process.env.FIREBASE_PROJECT_ID || "indo-174f0").trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) {
    throw new Error("FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are required.");
  }
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL: DATABASE_URL,
  });
}

function getMediaUrl(video) {
  return String(
    video?.secureUrl || video?.videoUrl || video?.url || "",
  ).trim();
}

function getCaption(video) {
  return String(
    video?.caption || video?.description || video?.title || "",
  ).trim().slice(0, 1024);
}

async function main() {
  if (!telegramStorageConfigured()) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.");
  }

  const firebaseApp = initFirebase();
  const db = getDatabaseWithUrl(DATABASE_URL, firebaseApp);
  const snapshot = await db.ref("videos").get();
  const videos = Object.entries(snapshot.val() || {});

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`Found ${videos.length} videos.`);

  for (const [videoId, video] of videos) {
    const media = video && typeof video === "object" ? video : {};
    if (media.storage?.provider === "telegram" || media.telegram?.fileId) {
      skipped += 1;
      continue;
    }

    const mediaUrl = getMediaUrl(media);
    if (!mediaUrl) {
      failed += 1;
      console.warn(`[${videoId}] skipped: no accessible media URL.`);
      continue;
    }

    try {
      const telegram = await mirrorVideoFromUrl({
        mediaUrl,
        caption: getCaption(media),
        fileName: String(media.title || videoId),
      });

      await db.ref(`videos/${videoId}`).update({
        telegram: {
          provider: "telegram",
          chatId: String(process.env.TELEGRAM_CHAT_ID || "").trim(),
          messageId: telegram.messageId,
          fileId: telegram.fileId,
          fileUniqueId: telegram.fileUniqueId,
          migratedAt: Date.now(),
        },
        storage: {
          provider: "telegram",
          migrationSource: "cloudinary",
          migratedAt: Date.now(),
        },
      });

      migrated += 1;
      console.log(`[${videoId}] migrated successfully.`);
    } catch (error) {
      failed += 1;
      console.warn(`[${videoId}] migration failed: ${error?.message || error}`);
    }
  }

  console.log(`Migration complete. migrated=${migrated} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`Migration aborted: ${error?.message || error}`);
  process.exitCode = 1;
});
