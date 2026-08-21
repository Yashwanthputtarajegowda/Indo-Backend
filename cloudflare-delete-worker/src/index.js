const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });

function corsHeaders(origin) {
  const allowed = origin && origin.endsWith("github.io") ? origin : "*";
  return { "access-control-allow-origin": allowed, "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "Authorization,Content-Type", "access-control-max-age": "86400" };
}

function decodeJwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const text = atob(base64);
    return JSON.parse(text);
  } catch { return null; }
}

async function firebaseGet(env, path, idToken) {
  const url = new URL(`${env.FIREBASE_DATABASE_URL.replace(/\/$/, "")}/${path}.json`);
  url.searchParams.set("auth", idToken);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Firebase read failed (${response.status})`);
  return data;
}

async function firebasePatch(env, updates, idToken) {
  const url = new URL(`${env.FIREBASE_DATABASE_URL.replace(/\/$/, "")}/.json`);
  url.searchParams.set("auth", idToken);
  const response = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(updates) });
  const data = await response.text();
  if (!response.ok) throw new Error(data || `Firebase update failed (${response.status})`);
}

async function getDriveAccessToken(env) {
  if (globalThis.__driveToken && globalThis.__driveTokenExpiresAt > Date.now() + 60_000) return globalThis.__driveToken;
  const body = new URLSearchParams({ client_id: env.GOOGLE_DRIVE_CLIENT_ID, client_secret: env.GOOGLE_DRIVE_CLIENT_SECRET, refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN, grant_type: "refresh_token" });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || "Could not refresh Google Drive access token.");
  globalThis.__driveToken = String(data.access_token);
  globalThis.__driveTokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000;
  return globalThis.__driveToken;
}

async function driveRequest(env, path, init = {}, forceRefresh = false) {
  if (forceRefresh) { globalThis.__driveToken = ""; globalThis.__driveTokenExpiresAt = 0; }
  const token = await getDriveAccessToken(env);
  const headers = new Headers(init.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`https://www.googleapis.com/drive/v3${path}`, { ...init, headers });
}

async function deleteDriveFile(env, fileId) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const metaUrl = `/files/${encodeURIComponent(fileId)}?fields=id,trashed,capabilities(canDelete)&supportsAllDrives=true`;
      const metaResponse = await driveRequest(env, metaUrl);
      const meta = await metaResponse.json().catch(() => ({}));
      if (metaResponse.status === 404) return { deleted: false, alreadyMissing: true };
      if (!metaResponse.ok || !meta?.id) throw new Error(meta?.error?.message || "Google Drive file lookup failed.");
      if (meta.trashed) return { deleted: false, alreadyMissing: true };
      if (meta.capabilities?.canDelete === false) throw new Error("Google Drive does not allow deletion for this file.");
      const delResponse = await driveRequest(env, `/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: "DELETE" });
      if (delResponse.status === 204 || delResponse.status === 200 || delResponse.status === 404) {
        for (let verify = 1; verify <= 5; verify++) {
          const check = await driveRequest(env, metaUrl);
          if (check.status === 404) return { deleted: true, verified: true, attempts: attempt };
          const checkData = await check.json().catch(() => ({}));
          if (check.ok && checkData.trashed) return { deleted: true, verified: true, trashed: true, attempts: attempt };
          await new Promise((resolve) => setTimeout(resolve, 300 * verify));
        }
        throw new Error("Drive delete returned success but verification still found the file.");
      }
      const errorData = await delResponse.json().catch(() => ({}));
      if (delResponse.status === 401 || delResponse.status === 403) {
        globalThis.__driveToken = "";
        globalThis.__driveTokenExpiresAt = 0;
      }
      throw new Error(errorData?.error?.message || `Google Drive delete failed (${delResponse.status}).`);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError || new Error("Google Drive delete failed.");
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get("origin"));
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, cors);

    const header = request.headers.get("authorization") || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return json({ ok: false, error: "Authentication required." }, 401, cors);
    const idToken = match[1].trim();
    const claims = decodeJwtPayload(idToken);
    if (!claims?.sub) return json({ ok: false, error: "Invalid authentication token." }, 401, cors);

    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const videoId = String(body.videoId || url.pathname.split("/").filter(Boolean).pop() || "").trim();
    if (!videoId) return json({ ok: false, error: "Video ID is required." }, 400, cors);

    try {
      let videoKey = videoId;
      let video = await firebaseGet(env, `videos/${encodeURIComponent(videoId)}`, idToken);

      if (!video || typeof video !== "object") {
        const allVideos = await firebaseGet(env, "videos", idToken);
        if (allVideos && typeof allVideos === "object") {
          for (const [key, item] of Object.entries(allVideos)) {
            if (item && String(item.id || key) === videoId) { videoKey = key; video = item; break; }
          }
        }
      }

      if (!video || typeof video !== "object") return json({ ok: true, alreadyDeleted: true, videoId }, 200, cors);

      const ownerUid = String(video.ownerUid || "").trim();
      if (!ownerUid || ownerUid !== String(claims.user_id || claims.sub || "")) return json({ ok: false, error: "You can delete only your own video." }, 403, cors);

      const fileId = String(video.googleDrive?.fileId || video.drive?.fileId || video.storage?.fileId || video.googleDriveFileId || "").trim();
      const provider = String(video.storage?.provider || "").trim().toLowerCase();
      if (!fileId && provider === "google-drive") return json({ ok: false, error: "Google Drive file ID is missing for this video." }, 409, cors);

      if (fileId) {
        const drive = await deleteDriveFile(env, fileId);
        if (!drive?.deleted && !drive?.alreadyMissing) return json({ ok: false, error: "Google Drive file could not be deleted." }, 502, cors);
      }

      const updates = {
        [`videos/${videoKey}`]: null,
        [`users/${ownerUid}/content/posts/${video.id || videoKey}`]: null,
        [`users/${ownerUid}/content/videos/${video.id || videoKey}`]: null,
        [`users/${ownerUid}/engagement/videos/${video.id || videoKey}`]: null,
        [`videoLikes/${videoKey}`]: null,
        [`videoComments/${videoKey}`]: null,
        [`videoSaves/${videoKey}`]: null,
      };
      if (video.id && video.id !== videoKey) {
        updates[`videos/${video.id}`] = null;
        updates[`videoLikes/${video.id}`] = null;
        updates[`videoComments/${video.id}`] = null;
        updates[`videoSaves/${video.id}`] = null;
      }
      await firebasePatch(env, updates, idToken);
      return json({ ok: true, deleted: true, videoId, firebaseKey: videoKey, driveDeleted: Boolean(fileId) }, 200, cors);
    } catch (error) {
      console.error("Drive delete worker failed", error);
      return json({ ok: false, error: String(error?.message || "Delete failed.").slice(0, 300) }, 502, cors);
    }
  },
};