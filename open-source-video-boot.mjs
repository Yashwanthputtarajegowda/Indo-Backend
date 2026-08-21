import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { deleteDriveFile } from "./services/google-drive-storage.js";
import { canonicalUserRoot } from "./services/user-canonical.js";

const MAX_VIDEO_BYTES = 700 * 1024 * 1024;
const CACHE_MS = 45_000;
const TOPICS = [
  "news", "cinema", "music", "comedy", "education", "technology", "sports", "history",
  "culture", "food", "travel", "agriculture", "business", "science", "interview", "devotional",
];
const cache = new Map();

function getDb() {
  if (admin.apps.length) return getDatabaseWithUrl(process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com", admin.app());
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  const app = admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), databaseURL: process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com" }, "open-source-video-feed");
  return getDatabaseWithUrl(process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com", app);
}

async function json(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Indo/1.0 open-source-video-feed" }, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clean(value, max = 240) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalize(item, source) {
  const url = String(item?.url || "").trim();
  const mime = String(item?.mime || "").toLowerCase();
  const size = Number(item?.size || 0);
  if (!/^https:\/\//i.test(url) || size > MAX_VIDEO_BYTES) return null;
  if (!mime.includes("video") && !/\.(mp4|webm|ogv|ogg)(?:$|[?#])/i.test(url)) return null;
  const id = String(item?.id || url).replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 180);
  return {
    id: `opensource-${source.replace(/\W+/g, "-").toLowerCase()}-${id}`,
    title: clean(item?.title || "Open-source video"),
    creator: clean(item?.creator || source, 120),
    ownerUid: "",
    description: clean(item?.description || "Open-licensed media", 500),
    videoUrl: url,
    secureUrl: url,
    streamUrl: url,
    thumbnailUrl: String(item?.thumbnail || "").trim(),
    mediaType: "video",
    source,
    license: clean(item?.license || "open", 120),
    createdAt: Number(item?.createdAt || Date.now()),
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    views: 0,
  };
}

async function wikimedia(query) {
  const params = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", generator: "search",
    gsrsearch: query, gsrnamespace: "6", gsrlimit: "15",
    prop: "imageinfo", iiprop: "url|mime|size|mediatype|extmetadata",
  });
  const data = await json(`https://commons.wikimedia.org/w/api.php?${params}`);
  const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
  return pages.map((page) => {
    const info = page?.imageinfo?.[0] || {};
    const meta = info.extmetadata || {};
    return normalize({
      id: page?.pageid || page?.title,
      title: page?.title?.replace(/^File:/, ""),
      creator: meta?.Artist?.value || info?.user,
      description: meta?.ImageDescription?.value,
      license: meta?.LicenseShortName?.value,
      url: info?.url,
      mime: info?.mime,
      size: info?.size,
      thumbnail: info?.thumburl,
    }, "Wikimedia Commons");
  }).filter(Boolean);
}

async function internetArchive(query) {
  const q = encodeURIComponent(`mediatype:movies AND (title:"${query}" OR subject:"${query}")`);
  const data = await json(`https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=description&rows=8&page=1&output=json`);
  const docs = Array.isArray(data?.response?.docs) ? data.response.docs : [];
  const results = await Promise.all(docs.map(async (doc) => {
    const id = clean(doc?.identifier, 180);
    if (!id) return null;
    const meta = await json(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    const files = Array.isArray(meta?.files) ? meta.files : [];
    const candidates = files.filter((file) => {
      const name = String(file?.name || "");
      const format = String(file?.format || "").toLowerCase();
      const size = Number(file?.size || 0);
      return size > 0 && size <= MAX_VIDEO_BYTES && (format.includes("mpeg4") || format.includes("h.264") || /\.mp4$/i.test(name)) && !/(thumb|sample|preview)/i.test(name);
    }).sort((a, b) => Number(a?.size || 0) - Number(b?.size || 0));
    const file = candidates[0];
    if (!file) return null;
    const path = String(file.name).split("/").map(encodeURIComponent).join("/");
    return normalize({
      id,
      title: doc?.title,
      creator: doc?.creator,
      description: doc?.description,
      license: meta?.metadata?.licenseurl || meta?.metadata?.license,
      url: `https://archive.org/download/${encodeURIComponent(id)}/${path}`,
      mime: "video/mp4",
      size: file?.size,
    }, "Internet Archive");
  }));
  return results.filter(Boolean);
}

async function openSourceFeed(language, topic, limit) {
  const key = `${language}|${topic}|${limit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_MS) return cached.items;
  const selected = topic ? [topic] : TOPICS;
  const queries = selected.map((item) => `${language} ${item}`);
  const settled = await Promise.allSettled(queries.flatMap((query) => [wikimedia(query), internetArchive(query)]));
  const items = [];
  const seen = new Set();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value || []) {
      const keyValue = String(item.videoUrl || item.id);
      if (!keyValue || seen.has(keyValue)) continue;
      seen.add(keyValue);
      items.push(item);
    }
  }
  const selectedItems = items.slice(0, Math.max(limit * 3, 30));
  cache.set(key, { time: Date.now(), items: selectedItems });
  return selectedItems;
}

const originalGet = express.application.get;
express.application.get = function patchedGet(path, ...handlers) {
  if (path !== "/api/media/videos") return originalGet.call(this, path, ...handlers);

  return originalGet.call(this, path, async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const type = String(req.query.type || "").trim().toLowerCase();
    const language = String(req.query.language || "Kannada").trim() || "Kannada";
    const topic = String(req.query.topic || "").trim();

    try {
      let videos = [];
      const db = getDb();
      if (db) {
        try {
          const snapshot = await db.ref("videos").get();
          videos = Object.values(snapshot.val() || {}).filter((item) => item && String(item.storage?.provider || item.telegram?.provider || "") === "telegram");
          videos.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
          if (type === "video" || type === "reel") videos = videos.filter((item) => (item.mediaType || "video") === type);
          const baseUrl = `${req.protocol || "https"}://${req.get("host")}`;
          videos = videos.slice(0, limit).map((item) => {
            const video = { ...item };
            const provider = String(video.storage?.provider || video.telegram?.provider || "").toLowerCase();
            if (provider === "telegram" && video.id) {
              const streamUrl = `${baseUrl}/api/media/videos/${encodeURIComponent(video.id)}/telegram-stream`;
              video.streamUrl = video.streamUrl || streamUrl;
              video.videoUrl = video.videoUrl || video.secureUrl || streamUrl;
              video.secureUrl = video.secureUrl || video.videoUrl || streamUrl;
            }
            return video;
          });
        } catch (error) {
          console.warn("Telegram video lookup skipped:", error?.message || error);
        }
      }

      const openVideos = await openSourceFeed(language, topic, limit);
      const seen = new Set(videos.map((item) => String(item.id || item.videoUrl || "")));
      for (const item of openVideos) {
        const keyValue = String(item.videoUrl || item.id || "");
        if (!keyValue || seen.has(keyValue)) continue;
        seen.add(keyValue);
        videos.push(item);
        if (videos.length >= limit) break;
      }

      return res.json({ ok: true, videos: videos.slice(0, limit) });
    } catch (error) {
      console.warn("Open-source video feed failed:", error?.message || error);
      return res.status(500).json({ ok: false, error: "Could not load videos." });
    }
  });
};

// Robust production delete override. The normal server route may address a video by
// the Realtime Database key while the UI/canonical copy uses video.id. Resolve both
// forms, recover the Drive fileId from canonical/legacy copies, delete Drive first,
// then remove every Firebase copy only after verified Drive deletion succeeds.
const originalPost = express.application.post;
express.application.post = function patchedPost(path, ...handlers) {
  if (path !== "/api/media/videos/:videoId/delete") return originalPost.call(this, path, ...handlers);

  return originalPost.call(this, path, async (req, res) => {
    const header = String(req.headers.authorization || "");
    if (!/^Bearer\s+\S+$/i.test(header)) return res.status(401).json({ ok: false, error: "Authentication required." });
    const auth = admin.apps.length ? admin.auth(admin.app()) : null;
    if (!auth) return res.status(503).json({ ok: false, error: "Authentication service is unavailable." });
    let user;
    try {
      user = await auth.verifyIdToken(header.replace(/^Bearer\s+/i, "").trim(), true);
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid or expired authentication token." });
    }

    const db = getDb();
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const requestedId = String(req.params.videoId || "").trim();
    if (!requestedId) return res.status(400).json({ ok: false, error: "Video ID is missing." });

    try {
      const [allVideosSnapshot, canonicalVideoSnapshot, canonicalPostSnapshot] = await Promise.all([
        db.ref("videos").get(),
        db.ref(`${canonicalUserRoot(user.uid)}/content/videos/${requestedId}`).get(),
        db.ref(`${canonicalUserRoot(user.uid)}/content/posts/${requestedId}`).get(),
      ]);

      const allVideos = allVideosSnapshot.val() || {};
      const globalMatches = Object.entries(allVideos).filter(([key, value]) => {
        if (!value) return false;
        if (String(value.ownerUid || "") !== String(user.uid || "")) return false;
        return key === requestedId || String(value.id || "") === requestedId;
      });

      const sources = [];
      for (const [key, value] of globalMatches) sources.push({ key, video: value });
      if (canonicalVideoSnapshot.exists()) sources.push({ key: requestedId, video: canonicalVideoSnapshot.val() || {} });
      if (canonicalPostSnapshot.exists()) sources.push({ key: requestedId, video: canonicalPostSnapshot.val() || {} });

      const unique = new Map();
      for (const source of sources) {
        const id = String(source.video?.id || source.key || requestedId).trim();
        if (!unique.has(id)) unique.set(id, source);
      }
      const resolved = Array.from(unique.values());
      if (!resolved.length) return res.status(404).json({ ok: false, error: "Video not found." });

      const ownerMismatch = resolved.some(({ video }) => {
        const owner = String(video?.ownerUid || "").trim();
        return owner && owner !== String(user.uid || "");
      });
      if (ownerMismatch) return res.status(403).json({ ok: false, error: "You can delete only your own video." });

      const driveFileIds = new Set();
      for (const { video } of resolved) {
        const candidates = [
          video?.googleDrive?.fileId,
          video?.drive?.fileId,
          video?.storage?.fileId,
          video?.googleDriveFileId,
        ];
        for (const candidate of candidates) {
          const id = String(candidate || "").trim();
          if (id) driveFileIds.add(id);
        }
      }

      if (String(resolved[0]?.video?.storage?.provider || "").toLowerCase() === "google-drive" && driveFileIds.size === 0) {
        return res.status(409).json({ ok: false, error: "Google Drive file ID is missing for this video." });
      }

      for (const fileId of driveFileIds) {
        const result = await deleteDriveFile(fileId);
        if (!result?.deleted && !result?.alreadyMissing) {
          return res.status(502).json({ ok: false, error: "Google Drive file could not be deleted." });
        }
      }

      const updates = {};
      for (const { key, video } of globalMatches) {
        updates[`videos/${key}`] = null;
        const id = String(video?.id || key).trim();
        updates[`${canonicalUserRoot(user.uid)}/content/posts/${id}`] = null;
        updates[`${canonicalUserRoot(user.uid)}/content/videos/${id}`] = null;
        updates[`${canonicalUserRoot(user.uid)}/engagement/videos/${id}`] = null;
        updates[`videoLikes/${id}`] = null;
        updates[`videoComments/${id}`] = null;
        updates[`videoSaves/${id}`] = null;
      }
      if (!globalMatches.length) {
        updates[`${canonicalUserRoot(user.uid)}/content/posts/${requestedId}`] = null;
        updates[`${canonicalUserRoot(user.uid)}/content/videos/${requestedId}`] = null;
        updates[`${canonicalUserRoot(user.uid)}/engagement/videos/${requestedId}`] = null;
        updates[`videoLikes/${requestedId}`] = null;
        updates[`videoComments/${requestedId}`] = null;
        updates[`videoSaves/${requestedId}`] = null;
      }
      await db.ref().update(updates);

      const previousPosts = Number((await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).get()).val() || 0);
      const previousVideos = Number((await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).get()).val() || 0);
      await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).set(Math.max(0, previousPosts - 1));
      await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).set(Math.max(0, previousVideos - 1));

      return res.json({ ok: true, videoId: requestedId, deleted: true, googleDriveDeleted: driveFileIds.size > 0, googleDriveFileCount: driveFileIds.size });
    } catch (error) {
      console.error("Robust video delete failed:", error?.stack || error?.message || error);
      return res.status(Number(error?.status) || 500).json({ ok: false, error: String(error?.message || "Could not delete video.").slice(0, 300) });
    }
  });
};
