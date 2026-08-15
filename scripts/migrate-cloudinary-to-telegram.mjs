import "dotenv/config";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { telegramStorageConfigured } from "../services/telegram-storage.js";

const DATABASE_URL = String(
  process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com",
).trim();
const TELEGRAM_BOT_TOKEN = () => String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = () => String(process.env.TELEGRAM_CHAT_ID || "").trim();
const TELEGRAM_BOT_UPLOAD_LIMIT = 50 * 1024 * 1024;

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

async function uploadVideoToTelegramFromUrl({ mediaUrl, caption, fileName }) {
  const response = await fetch(mediaUrl, {
    headers: { Accept: "video/*,*/*;q=0.8" },
  });
  if (!response.ok) {
    throw new Error(`Cloudinary fetch failed with HTTP ${response.status}.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("Cloudinary returned an empty file.");
  if (buffer.length > TELEGRAM_BOT_UPLOAD_LIMIT) {
    throw new Error(
      `File is ${Math.ceil(buffer.length / 1024 / 1024)} MB; standard Telegram Bot API upload limit is 50 MB.`,
    );
  }

  const contentType =
    String(response.headers.get("content-type") || "video/mp4").split(";")[0].trim() ||
    "video/mp4";
  const form = new FormData();
  form.set("chat_id", TELEGRAM_CHAT_ID());
  form.set("caption", String(caption || "").slice(0, 1024));
  form.set(
    "video",
    new Blob([buffer], { type: contentType }),
    String(fileName || "indo-video").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120),
  );

  const telegramResponse = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(TELEGRAM_BOT_TOKEN())}/sendVideo`,
    { method: "POST", body: form },
  );
  const data = await telegramResponse.json().catch(() => ({}));
  if (!telegramResponse.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram sendVideo failed (HTTP ${telegramResponse.status}).`);
  }

  const message = data.result || {};
  const video = message.video || {};
  if (!video.file_id) throw new Error("Telegram did not return a video file_id.");

  return {
    storage: "telegram",
    fileId: String(video.file_id),
    fileUniqueId: String(video.file_unique_id || ""),
    messageId: Number(message.message_id || 0),
  };
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
      console.warn(`[${videoId}] failed: no accessible media URL.`);
      continue;
    }

    try {
      const telegram = await uploadVideoToTelegramFromUrl({
        mediaUrl,
        caption: getCaption(media),
        fileName: String(media.title || videoId),
      });

      const now = Date.now();
      await db.ref(`videos/${videoId}`).update({
        telegram: {
          provider: "telegram",
          chatId: TELEGRAM_CHAT_ID(),
          messageId: telegram.messageId,
          fileId: telegram.fileId,
          fileUniqueId: telegram.fileUniqueId,
          migratedAt: now,
        },
        storage: {
          provider: "telegram",
          migrationSource: "cloudinary",
          migratedAt: now,
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
