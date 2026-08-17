import "dotenv/config";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

const DATABASE_URL = String(process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com").trim();
const CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024 * 1024;

function env(name) { return String(process.env[name] || "").trim(); }

function buildBots() {
  const bots = [];
  for (let index = 1; index <= 50; index += 1) {
    const token = env(`TELEGRAM_BOT_TOKEN_${index}`) || (index === 1 ? env("TELEGRAM_BOT_TOKEN") : "");
    const chatId = env(`TELEGRAM_CHAT_ID_${index}`) || env("TELEGRAM_CHAT_ID");
    if (token && chatId) bots.push({ key: `bot-${index}`, index, token, chatId });
  }
  return bots;
}

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = env("FIREBASE_PROJECT_ID") || "indo-174f0";
  const clientEmail = env("FIREBASE_CLIENT_EMAIL");
  const privateKey = env("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) throw new Error("FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are required.");
  return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), databaseURL: DATABASE_URL });
}

async function telegramCall(bot, method, form) {
  const response = await fetch(`https://api.telegram.org/bot${bot.token}/${method}`, { method: "POST", body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.description || `Telegram ${method} failed (HTTP ${response.status}).`);
  return data.result;
}

async function uploadChunk(bot, buffer, fileName, caption) {
  const form = new FormData();
  form.set("chat_id", bot.chatId);
  form.set("caption", caption);
  form.set("document", new Blob([buffer], { type: "application/octet-stream" }), fileName);
  const message = await telegramCall(bot, "sendDocument", form);
  const document = message?.document;
  if (!document?.file_id) throw new Error("Telegram did not return a chunk file_id.");
  return { fileId: String(document.file_id), fileUniqueId: String(document.file_unique_id || ""), messageId: Number(message.message_id || 0), size: buffer.length };
}

async function migrateVideo(db, videoId, video, bots) {
  if (video?.storage?.provider === "telegram" && video?.telegram?.uploadId) return "skipped";
  const mediaUrl = String(video?.secureUrl || video?.videoUrl || video?.url || "").trim();
  if (!mediaUrl) throw new Error("No accessible Cloudinary media URL.");

  const response = await fetch(mediaUrl, { headers: { Accept: "video/*,*/*;q=0.8" } });
  if (!response.ok) throw new Error(`Source media fetch failed with HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("Source media is empty.");
  if (buffer.length > MAX_TOTAL_SIZE) throw new Error("Video exceeds the 20 GB migration safety limit.");

  const bot = bots[(Math.abs(hash(videoId)) % bots.length)];
  const uploadId = `mig-${videoId}-${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);
  const fileName = String(video?.title || videoId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) + ".mp4";
  const mimeType = String(video?.mimeType || response.headers.get("content-type") || "video/mp4").split(";")[0].trim() || "video/mp4";
  const uploadRef = db.ref(`telegramUploads/migrations/${uploadId}`);

  await uploadRef.set({
    uploadId,
    ownerUid: String(video?.ownerUid || ""),
    fileName,
    mimeType,
    mediaType: video?.mediaType === "reel" ? "reel" : "video",
    title: String(video?.title || "Untitled video").slice(0, 120),
    caption: String(video?.caption || "").slice(0, 500),
    size: buffer.length,
    totalChunks,
    chunkSize: CHUNK_SIZE,
    assignedBotKey: bot.key,
    assignedBotIndex: bot.index,
    status: "migrating",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const chunks = {};
  for (let index = 0; index < totalChunks; index += 1) {
    const from = index * CHUNK_SIZE;
    const part = buffer.subarray(from, Math.min(buffer.length, from + CHUNK_SIZE));
    const result = await uploadChunk(bot, part, `${fileName}.part${String(index).padStart(6, "0")}`, `INDO_MIGRATION ${uploadId} ${index + 1}/${totalChunks}`);
    chunks[index] = { index, size: result.size, botKey: bot.key, botIndex: bot.index, fileId: result.fileId, fileUniqueId: result.fileUniqueId, messageId: result.messageId, uploadedAt: Date.now() };
    await uploadRef.child(`chunks/${index}`).set(chunks[index]);
    await uploadRef.update({ uploadedChunks: index + 1, updatedAt: Date.now() });
  }

  const now = Date.now();
  const streamUrl = `${env("PUBLIC_BACKEND_URL") || ""}/api/media/videos/telegram/${encodeURIComponent(uploadId)}/stream`;
  const telegram = { provider: "telegram", uploadId, chunkSize: CHUNK_SIZE, totalChunks, size: buffer.length, chatId: bot.chatId, botKey: bot.key, migratedAt: now };
  await db.ref(`videos/${videoId}`).update({
    storage: { provider: "telegram", migrationSource: "cloudinary", migratedAt: now },
    telegram,
    secureUrl: streamUrl || video.secureUrl || "",
    videoUrl: streamUrl || video.videoUrl || "",
    mimeType,
  });
  await uploadRef.update({ status: "complete", videoId, updatedAt: now });
  return "migrated";
}

function hash(value) {
  let h = 2166136261;
  for (const char of String(value)) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}

async function main() {
  const bots = buildBots();
  if (!bots.length) throw new Error("No Telegram bots are configured.");
  const app = initFirebase();
  const db = getDatabaseWithUrl(DATABASE_URL, app);
  const snapshot = await db.ref("videos").get();
  const videos = Object.entries(snapshot.val() || {});
  let migrated = 0, skipped = 0, failed = 0;
  console.log(`Found ${videos.length} videos. Migrating to Telegram in ${CHUNK_SIZE / 1024 / 1024} MB chunks.`);

  for (const [videoId, video] of videos) {
    try {
      const result = await migrateVideo(db, videoId, video || {}, bots);
      if (result === "skipped") skipped += 1;
      else migrated += 1;
      console.log(`[${videoId}] ${result}`);
    } catch (error) {
      failed += 1;
      console.error(`[${videoId}] FAILED: ${error?.message || error}`);
    }
  }
  console.log(`Migration complete: migrated=${migrated} skipped=${skipped} failed=${failed}`);
  if (failed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`Migration aborted: ${error?.message || error}`);
  process.exitCode = 1;
});
