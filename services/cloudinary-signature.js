import crypto from "node:crypto";

export function createCloudinarySignature(timestamp, params = {}) {
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!apiSecret) throw new Error("Cloudinary API secret is not configured.");

  const payload = Object.entries({ ...params, timestamp })
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    )
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
  const id = String(publicId || "").trim();
  if (!id) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const { cloudName, apiKey } = getCloudinaryConfig();
  const signature = createCloudinarySignature(timestamp, {
    public_id: id,
    invalidate: true,
    type: "upload",
  });
  const body = new URLSearchParams({
    public_id: id,
    api_key: apiKey,
    timestamp: String(timestamp),
    signature,
    invalidate: "true",
    type: "upload",
  });
  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/video/destroy`,
    { method: "POST", body },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.result === "error") {
    throw new Error(data.error?.message || "Cloudinary story deletion failed.");
  }
}

// Keep this module as the Cloudinary story-delete deploy trigger used by Railway.
