import { Readable } from "node:stream";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_FOLDER_NAME = "Indo Video Storage";

function env(name) {
  return String(process.env[name] || "").trim();
}

function requireConfig() {
  const clientId = env("GOOGLE_DRIVE_CLIENT_ID");
  const clientSecret = env("GOOGLE_DRIVE_CLIENT_SECRET");
  const redirectUri = env("GOOGLE_DRIVE_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google Drive OAuth is not configured.");
  }
  return { clientId, clientSecret, redirectUri };
}

function encode(value) {
  return encodeURIComponent(String(value));
}

export function googleDriveConfigured() {
  return Boolean(env("GOOGLE_DRIVE_CLIENT_ID") && env("GOOGLE_DRIVE_CLIENT_SECRET") && env("GOOGLE_DRIVE_REDIRECT_URI"));
}

export function getGoogleDriveAuthorizationUrl(state = "") {
  const { clientId, redirectUri } = requireConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: "https://www.googleapis.com/auth/drive",
  });
  if (state) params.set("state", state);
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

export async function exchangeAuthorizationCode(code) {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  const body = new URLSearchParams({
    code: String(code),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetch(OAUTH_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.refresh_token) {
    throw new Error(data?.error_description || "Google did not return a refresh token. Re-authorize with consent.");
  }
  return data;
}

async function getAccessToken() {
  const refreshToken = env("GOOGLE_DRIVE_REFRESH_TOKEN");
  if (!refreshToken) throw new Error("Google Drive is not authorized yet. Open /api/google-drive/auth first.");
  const { clientId, clientSecret } = requireConfig();
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  const response = await fetch(OAUTH_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) throw new Error(data?.error_description || "Could not refresh the Google Drive access token.");
  return data.access_token;
}

async function driveFetch(path, init = {}) {
  const token = await getAccessToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${DRIVE_API}${path}`, { ...init, headers });
}

async function findFolderId() {
  const configured = env("GOOGLE_DRIVE_FOLDER_ID");
  if (configured) return configured;
  const folderName = env("GOOGLE_DRIVE_FOLDER_NAME") || DEFAULT_FOLDER_NAME;
  const query = `'root' in parents and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const params = new URLSearchParams({ q: query, spaces: "drive", fields: "files(id,name)", pageSize: "10" });
  const response = await driveFetch(`/files?${params.toString()}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.files?.length) throw new Error(`Google Drive folder '${folderName}' was not found. Set GOOGLE_DRIVE_FOLDER_ID or create that folder in My Drive.`);
  return String(data.files[0].id);
}

export async function uploadVideoToDrive({ body, fileName, mimeType }) {
  const folderId = await findFolderId();
  const metadata = { name: fileName, parents: [folderId], mimeType };
  const boundary = `indo-drive-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const prefix = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([prefix, body, suffix]);
  const response = await driveFetch(`/files?uploadType=multipart&fields=id,name,mimeType,size,webContentLink`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": String(payload.length) },
    body: payload,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id) throw new Error(data?.error?.message || "Google Drive upload failed.");
  return { ...data, folderId };
}

export async function getDriveFile(fileId) {
  const params = new URLSearchParams({ fields: "id,name,mimeType,size,trashed" });
  const response = await driveFetch(`/files/${encode(fileId)}?${params.toString()}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id || data.trashed) throw new Error(data?.error?.message || "Google Drive file not found.");
  return data;
}

export async function getDriveStream(fileId, range = "", method = "GET") {
  const headers = { Accept: "video/*,*/*;q=0.8" };
  if (range) headers.Range = range;
  return driveFetch(`/files/${encode(fileId)}?alt=media`, { method, headers, redirect: "follow" });
}

export async function driveHealth() {
  const folderId = await findFolderId();
  const file = await getDriveFile(folderId).catch(() => null);
  return { ok: true, folderId, authorized: Boolean(file || folderId) };
}

export { Readable };
