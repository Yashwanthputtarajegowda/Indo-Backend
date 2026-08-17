import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";

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
  const selected = topic ? [topic] : TOPICS.slice(0, 6);
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
  items.sort(() => Math.random() - 0.5);
  const selectedItems = items.slice(0, Math.max(limit * 3, 30));
  cache.set(key, { time: Date.now(), items: selectedItems });
  return selectedItems;
}

const originalGet = express.application.get;
express.application.get = function patchedGet(path, ...handlers) {
  if (path !== "/api/media/videos") return originalGet.call(this, path, ...handlers);

  return originalGet.call(this, path, async (req, res) => {
    const db = getDb();
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const type = String(req.query.type || "").trim().toLowerCase();
    const language = String(req.query.language || "Kannada").trim() || "Kannada";
    const topic = String(req.query.topic || "").trim();
    try {
      const snapshot = await db.ref("videos").get();
      let videos = Object.values(snapshot.val() || {}).filter((item) => item && String(item.storage?.provider || item.telegram?.provider || "") === "telegram");
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
