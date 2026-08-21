const { onValueDeleted } = require("firebase-functions/v2/database");
const { defineSecret } = require("firebase-functions/params");

const DRIVE_CLIENT_ID = defineSecret("GOOGLE_DRIVE_CLIENT_ID");
const DRIVE_CLIENT_SECRET = defineSecret("GOOGLE_DRIVE_CLIENT_SECRET");
const DRIVE_REFRESH_TOKEN = defineSecret("GOOGLE_DRIVE_REFRESH_TOKEN");

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value || "").trim();

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: DRIVE_CLIENT_ID.value(),
    client_secret: DRIVE_CLIENT_SECRET.value(),
    refresh_token: DRIVE_REFRESH_TOKEN.value(),
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || "Google Drive access token refresh failed.");
  }
  return String(data.access_token);
}

async function getDriveFile(accessToken, fileId) {
  const params = new URLSearchParams({
    fields: "id,name,trashed,capabilities(canDelete)",
    supportsAllDrives: "true",
  });
  const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 404 || data.trashed) return null;
  if (!response.ok) throw new Error(data?.error?.message || `Drive lookup failed (${response.status}).`);
  return data;
}

async function verifyGone(accessToken, fileId) {
  const file = await getDriveFile(accessToken, fileId);
  return !file;
}

async function deleteDriveFile(fileId) {
  const id = clean(fileId);
  if (!id) return { skipped: true };

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      let accessToken = await getAccessToken();
      const existing = await getDriveFile(accessToken, id);
      if (!existing) return { deleted: false, alreadyMissing: true };
      if (existing.capabilities?.canDelete === false) {
        throw new Error("Google Drive account cannot delete this file.");
      }

      let response = await fetch(
        `${DRIVE_API}/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
        { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
      );

      if ((response.status === 401 || response.status === 403) && attempt === 1) {
        accessToken = await getAccessToken();
        response = await fetch(
          `${DRIVE_API}/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
          { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
        );
      }

      if (response.status === 404) return { deleted: false, alreadyMissing: true };
      if (!response.ok && response.status !== 200 && response.status !== 204) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error?.message || `Drive delete failed (${response.status}).`);
      }

      for (let verifyAttempt = 1; verifyAttempt <= MAX_ATTEMPTS; verifyAttempt += 1) {
        if (await verifyGone(accessToken, id)) {
          return { deleted: true, verified: true, attempts: attempt };
        }
        await sleep(300 * verifyAttempt);
      }
      throw new Error("Drive reported delete success, but verification still finds the file.");
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await sleep(600 * attempt);
    }
  }

  throw lastError || new Error("Could not delete Google Drive file.");
}

function getDriveFileId(video) {
  return clean(
    video?.googleDrive?.fileId ||
      video?.drive?.fileId ||
      video?.storage?.fileId ||
      video?.googleDriveFileId,
  );
}

exports.deleteGoogleDriveWhenVideoDeleted = onValueDeleted(
  {
    ref: "/videos/{videoId}",
    region: "asia-south1",
    secrets: [DRIVE_CLIENT_ID, DRIVE_CLIENT_SECRET, DRIVE_REFRESH_TOKEN],
    retry: true,
    maxInstances: 10,
  },
  async (event) => {
    const videoId = clean(event.params.videoId);
    const video = event.data?.val?.() || {};
    const fileId = getDriveFileId(video);

    if (!fileId) {
      console.warn(`[Drive cleanup] ${videoId}: no Google Drive fileId in deleted video record.`);
      return;
    }

    const result = await deleteDriveFile(fileId);
    console.log(`[Drive cleanup] ${videoId}:`, JSON.stringify({ fileId, ...result }));
  },
);
