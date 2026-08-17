import crypto from "node:crypto";

function env(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

export function getCloudinaryConfig() {
  const cloudName = env("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_CLOUDNAME");
  const apiKey = env("CLOUDINARY_API_KEY", "CLOUDINARY_APIKEY");
  const apiSecret = env("CLOUDINARY_API_SECRET", "CLOUDINARY_APISECRET");
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary is not configured on the backend.");
  }
  return { cloudName, apiKey, apiSecret };
}

export function createCloudinarySignature(timestamp, params = {}) {
  const { apiSecret } = getCloudinaryConfig();
  const normalizedTimestamp = String(timestamp || "").trim();
  if (!/^\d{1,20}$/.test(normalizedTimestamp)) {
    throw new Error("Invalid Cloudinary timestamp.");
  }

  const entries = Object.entries({ ...params, timestamp: normalizedTimestamp })
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    .sort(([a], [b]) => a.localeCompare(b));

  const payload = entries
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");

  return crypto.createHash("sha1").update(`${payload}${apiSecret}`, "utf8").digest("hex");
}
