import "dotenv/config";
import crypto from "node:crypto";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

const CLOUD_NAME = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
const API_KEY = String(process.env.CLOUDINARY_API_KEY || "").trim();
const API_SECRET = String(process.env.CLOUDINARY_API_SECRET || "").trim();
const DATABASE_URL = String(
  process.env.FIREBASE_DATABASE_URL ||
    "https://indo-174f0-default-rtdb.firebaseio.com",
).trim();

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = String(process.env.FIREBASE_PROJECT_ID || "indo-174f0");
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL: DATABASE_URL,
  });
}

function signCloudinary(params) {
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return crypto.createHash("sha1").update(`${payload}${API_SECRET}`).digest("hex");
}

async function listCloudinaryVideos() {
  if (!CLOUD_NAME || !API_KEY || !API_SECRET) return [];
  const auth = Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");
  const items = [];
  let nextCursor = "";

  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({
      max_results: "100",
      prefix: "indo/videos/",
    });
    if (nextCursor) query.set("next_cursor", nextCursor);
    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUD_NAME)}/resources/video/upload?${query}`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error?.message || `Cloudinary list failed (${response.status}).`);
    }
    for (const asset of Array.isArray(data.resources) ? data.resources : []) items.push(asset);
    nextCursor = String(data.next_cursor || "");
    if (!nextCursor) break;
  }
  return items;
}

function ownerUidFromPublicId(publicId) {
  const prefix = "indo/videos/";
  if (!String(publicId).startsWith(prefix)) return "";
  const rest = String(publicId).slice(prefix.length);
  return String(rest.split("/")[0] || "").trim();
}

function titleFromPublicId(publicId) {
  const value = String(publicId || "").split("/").pop() || "Video";
  return value.replace(/[_-]+/g, " ").replace(/\.(mp4|mov|webm|mkv)$/i, "").trim() || "Video";
}

async function syncCloudinaryVideos() {
  if (!CLOUD_NAME || !API_KEY || !API_SECRET) return;
  const firebaseApp = initFirebase();
  if (!firebaseApp) return;
  const db = getDatabaseWithUrl(DATABASE_URL, firebaseApp);

  const assets = await listCloudinaryVideos();
  if (!assets.length) return;

  const snapshot = await db.ref("videos").get();
  const existing = new Map();
  for (const [id, item] of Object.entries(snapshot.val() || {})) {
    if (item?.publicId) existing.set(String(item.publicId), { id, item });
  }

  for (const asset of assets) {
    const publicId = String(asset.public_id || "").trim();
    const secureUrl = String(asset.secure_url || "").trim();
    const ownerUid = ownerUidFromPublicId(publicId);
    if (!publicId || !secureUrl || !ownerUid) continue;

    const duration = Number(asset.duration || 0);
    const width = Number(asset.width || 0);
    const height = Number(asset.height || 0);
    const createdAt = Date.parse(String(asset.created_at || "")) || Date.now();
    const current = existing.get(publicId);

    if (current) {
      const patch = {};
      if (current.item.secureUrl !== secureUrl) patch.secureUrl = secureUrl;
      if (current.item.videoUrl !== secureUrl) patch.videoUrl = secureUrl;
      if (!current.item.ownerUid) patch.ownerUid = ownerUid;
      if (Object.keys(patch).length) await db.ref(`videos/${current.id}`).update(patch);
      continue;
    }

    const ref = db.ref("videos").push();
    const video = {
      id: ref.key,
      mediaType: "video",
      ownerUid,
      creator: `@${ownerUid.slice(0, 12)}`,
      creatorName: "Indo User",
      title: titleFromPublicId(publicId),
      caption: "",
      publicId,
      secureUrl,
      videoUrl: secureUrl,
      duration: Number.isFinite(duration) ? duration : 0,
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0,
      views: 0,
      likes: 0,
      importedFromCloudinary: true,
      createdAt,
    };
    await ref.set(video);
  }
}

try {
  await syncCloudinaryVideos();
} catch (error) {
  console.warn("Cloudinary startup sync skipped:", String(error?.message || error || "unknown error"));
}
