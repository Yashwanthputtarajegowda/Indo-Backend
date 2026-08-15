import crypto from "node:crypto";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

const ALLOWED_MEDIA_PREFIXES = ["indo/videos/", "indo/stories/"];
const MAX_PUBLIC_ID_LENGTH = 500;

function normalizePublicId(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
}

function isSafePublicId(publicId) {
  if (!publicId || publicId.length > MAX_PUBLIC_ID_LENGTH) return false;
  if (publicId.includes("..")) return false;
  if (/%2f|%2e|%5c/i.test(publicId)) return false;
  if (!/^[A-Za-z0-9._\/-]+$/.test(publicId)) return false;
  return ALLOWED_MEDIA_PREFIXES.some((prefix) => publicId.startsWith(prefix));
}

function initDatabase() {
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
    const databaseURL = process.env.FIREBASE_DATABASE_URL;
    if (clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        databaseURL,
      });
    }
  }
  if (!admin.apps.length) return null;
  const databaseURL = process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com";
  return getDatabaseWithUrl(databaseURL, admin.app());
}

async function assertUniqueMediaOwnership(publicId) {
  const db = initDatabase();
  if (!db) throw new Error("Media ownership verification is unavailable.");

  const [videosSnapshot, storiesSnapshot] = await Promise.all([
    db.ref("videos").get(),
    db.ref("stories").get(),
  ]);

  const owners = new Set();
  for (const item of Object.values(videosSnapshot.val() || {})) {
    if (item && String(item.publicId || "") === publicId && item.ownerUid) {
      owners.add(String(item.ownerUid));
    }
  }
  for (const item of Object.values(storiesSnapshot.val() || {})) {
    if (item && String(item.publicId || "") === publicId && item.ownerUid) {
      owners.add(String(item.ownerUid));
    }
  }

  // A Cloudinary public ID may never be attached to multiple Indo accounts.
  // This blocks an attacker from publishing a duplicate record that points at
  // another user's existing Cloudinary asset and then deleting it through the API.
  if (owners.size > 1) {
    throw new Error("Cloudinary asset ownership conflict detected.");
  }
}

export function createCloudinarySignature(timestamp, params = {}) {
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!apiSecret) throw new Error("Cloudinary API secret is not configured.");

  const payload = Object.entries({ ...params, timestamp })
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto.createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

export function getCloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  if (!cloudName || !apiKey)
    throw new Error("Cloudinary cloud name or API key is not configured.");
  return { cloudName, apiKey };
}

export async function destroyCloudinaryVideo(publicId) {
  const id = normalizePublicId(publicId);
  if (!id) return { result: "skipped" };
  if (!isSafePublicId(id)) {
    throw new Error("Cloudinary asset is outside the Indo media namespace.");
  }

  await assertUniqueMediaOwnership(id);

  const timestamp = Math.floor(Date.now() / 1000);
  const { cloudName, apiKey } = getCloudinaryConfig();
  const resourceType = "video";
  const type = "upload";
  const invalidate = true;
  const signature = createCloudinarySignature(timestamp, {
    public_id: id,
    invalidate,
    resource_type: resourceType,
    type,
  });
  const body = new URLSearchParams({
    public_id: id,
    api_key: apiKey,
    timestamp: String(timestamp),
    signature,
    invalidate: "true",
    resource_type: resourceType,
    type,
  });
  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${resourceType}/destroy`,
    { method: "POST", body },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.result === "error") {
    throw new Error(
      data.error?.message || `Cloudinary ${resourceType} deletion failed.`,
    );
  }
  return data;
}

export async function cloudinaryAssetExists(publicId) {
  const id = normalizePublicId(publicId);
  if (!id || !isSafePublicId(id)) return false;
  const { cloudName, apiKey } = getCloudinaryConfig();
  const token = Buffer.from(
    `${apiKey}:${process.env.CLOUDINARY_API_SECRET || ""}`,
  ).toString("base64");
  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/resources/video/upload/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Basic ${token}` } },
  );
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error(`Cloudinary asset lookup failed (${response.status}).`);
  return true;
}

// Keep this module as the Cloudinary media-delete deploy trigger used by Railway.
