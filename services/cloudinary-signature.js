import crypto from "node:crypto";

const ALLOWED_MEDIA_PREFIXES = ["indo/videos/", "indo/stories/"];

function normalizePublicId(value) {
  return String(value || "").trim().replace(/^\/+/, "");
}

function isAllowedMediaPublicId(publicId) {
  return ALLOWED_MEDIA_PREFIXES.some((prefix) => publicId.startsWith(prefix));
}

export function createCloudinarySignature(
  timestamp,
  params = {},
) {
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!apiSecret)
    throw new Error("Cloudinary API secret is not configured.");

  const payload = Object.entries({
    ...params,
    timestamp,
  })
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto
    .createHash("sha1")
    .update(`${payload}${apiSecret}`)
    .digest("hex");
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

  // Never allow the backend delete endpoint to target arbitrary Cloudinary assets.
  // Indo media must live under one of the application-owned namespaces.
  if (!isAllowedMediaPublicId(id)) {
    throw new Error("Cloudinary asset is outside the Indo media namespace.");
  }

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
  if (!id) return false;
  if (!isAllowedMediaPublicId(id)) return false;
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
