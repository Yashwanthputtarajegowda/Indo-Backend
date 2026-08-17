const CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_BOTS = 50;
const LEASE_STALE_MS = 10 * 60 * 1000;

function env(name) {
  return String(process.env[name] || "").trim();
}

function buildBotPool() {
  const bots = [];
  for (let index = 1; index <= MAX_BOTS; index += 1) {
    const numberedToken = env(`TELEGRAM_BOT_TOKEN_${index}`);
    const numberedChat = env(`TELEGRAM_CHAT_ID_${index}`);
    const token = numberedToken || (index === 1 ? env("TELEGRAM_BOT_TOKEN") : "");
    const chatId = numberedChat || env("TELEGRAM_CHAT_ID");
    if (token && chatId) bots.push({ key: `bot-${index}`, index, token, chatId });
  }
  return bots;
}

function safeUploadId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9_-]{8,120}$/.test(id) ? id : "";
}
function safeChunkIndex(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : null;
}
function safeTotalChunks(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 100000 ? n : null;
}
function safeFileName(value) {
  const raw = String(value || "indo-file.bin").trim();
  return raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "indo-file.bin";
}

async function telegramCall(bot, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${bot.token}/${method}`, { method: "POST", body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.description || `Telegram ${method} failed.`);
    error.telegramResponse = data;
    error.status = response.status;
    throw error;
  }
  return data.result;
}

async function reserveBot(db, bots) {
  if (!bots.length) throw new Error("No Telegram bots are configured.");
  if (!db) return bots[Math.floor(Math.random() * bots.length)];
  const snapshots = await Promise.all(bots.map(async (bot) => {
    const snapshot = await db.ref(`telegramBotState/${bot.key}`).get();
    const state = snapshot.val() || {};
    const stale = Number(state.updatedAt || 0) + LEASE_STALE_MS < Date.now();
    return { bot, active: stale ? 0 : Math.max(0, Number(state.active || 0)) };
  }));
  snapshots.sort((a, b) => a.active - b.active || a.bot.index - b.bot.index);
  const chosen = snapshots[0].bot;
  await db.ref(`telegramBotState/${chosen.key}`).transaction((current) => {
    const state = current && typeof current === "object" ? current : {};
    const stale = Number(state.updatedAt || 0) + LEASE_STALE_MS < Date.now();
    return { active: (stale ? 0 : Math.max(0, Number(state.active || 0))) + 1, updatedAt: Date.now() };
  });
  return chosen;
}
async function releaseBot(db, bot) {
  if (!db || !bot) return;
  await db.ref(`telegramBotState/${bot.key}`).transaction((current) => {
    const state = current && typeof current === "object" ? current : {};
    return { active: Math.max(0, Number(state.active || 0) - 1), updatedAt: Date.now() };
  });
}
function getBotByKey(bots, key) {
  return bots.find((bot) => bot.key === String(key || "")) || null;
}

async function getTelegramChunkBuffer(db, upload, chunkIndex) {
  const chunk = upload?.chunks?.[chunkIndex];
  if (!chunk?.fileId) throw new Error("Telegram chunk metadata is missing.");
  const bot = getBotByKey(buildBotPool(), chunk.botKey);
  if (!bot) throw new Error("The Telegram bot that owns this chunk is not configured.");
  await reserveBot(db, [bot]);
  try {
    const form = new FormData();
    form.set("file_id", String(chunk.fileId));
    const file = await telegramCall(bot, "getFile", form);
    const filePath = String(file?.file_path || "").trim();
    if (!filePath) throw new Error("Telegram file path is missing.");
    const response = await fetch(`https://api.telegram.org/file/bot${bot.token}/${filePath}`);
    if (!response.ok) throw new Error(`Telegram file download failed (HTTP ${response.status}).`);
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > CHUNK_SIZE) throw new Error("Downloaded chunk is invalid.");
    return data;
  } finally {
    await releaseBot(db, bot);
  }
}

export function getTelegramChunkConfig() {
  const bots = buildBotPool();
  return { chunkSize: CHUNK_SIZE, botCount: bots.length, configured: bots.length > 0 };
}

export function createTelegramChunkRouter({ express, db, auth, saveVideo }) {
  const router = express.Router();
  const requireUser = async (req, res, next) => {
    if (!auth) return res.status(503).json({ ok: false, error: "Authentication service is unavailable." });
    const header = String(req.headers.authorization || "");
    if (!/^Bearer\s+\S+$/i.test(header)) return res.status(401).json({ ok: false, error: "Authentication required." });
    try {
      req.telegramUser = await auth.verifyIdToken(header.replace(/^Bearer\s+/i, "").trim(), true);
      return next();
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid or expired authentication token." });
    }
  };

  router.get("/api/telegram/storage", requireUser, (_req, res) => res.json({ ok: true, ...getTelegramChunkConfig() }));

  router.post("/api/telegram/uploads", requireUser, async (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const totalChunks = safeTotalChunks(req.body?.totalChunks);
    const size = Number(req.body?.size || 0);
    const fileName = safeFileName(req.body?.fileName);
    const mimeType = String(req.body?.mimeType || "application/octet-stream").slice(0, 120);
    const mediaType = String(req.body?.mediaType || "video").toLowerCase() === "reel" ? "reel" : "video";
    const title = String(req.body?.title || "").trim().slice(0, 120);
    const caption = String(req.body?.caption || "").trim().slice(0, 500);
    const privacyRaw = String(req.body?.privacy || "public");
    const privacy = ["public", "followers", "private"].includes(privacyRaw) ? privacyRaw : "public";
    const allowComments = String(req.body?.allowComments ?? "true") !== "false";
    const allowDuet = String(req.body?.allowDuet ?? "true") !== "false";
    const category = String(req.body?.category || "").trim().slice(0, 60);
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 20).map((v) => String(v).trim()).filter(Boolean) : [];
    const location = String(req.body?.location || "").trim().slice(0, 120);
    const duration = Number(req.body?.duration || 0);
    const width = Number(req.body?.width || 0);
    const height = Number(req.body?.height || 0);
    if (!totalChunks || !Number.isFinite(size) || size <= 0 || size > 20 * 1024 * 1024 * 1024 || !title) {
      return res.status(400).json({ ok: false, error: "Invalid upload metadata." });
    }
    const uploadRef = db.ref(`telegramUploads/${req.telegramUser.uid}`).push();
    const uploadId = uploadRef.key;
    await uploadRef.set({ uploadId, ownerUid: req.telegramUser.uid, fileName, mimeType, mediaType, title, caption, privacy, allowComments, allowDuet, category, tags, location, duration: Number.isFinite(duration) ? duration : 0, width: Number.isFinite(width) ? width : 0, height: Number.isFinite(height) ? height : 0, size, totalChunks, chunkSize: CHUNK_SIZE, uploadedChunks: 0, status: "uploading", createdAt: Date.now(), updatedAt: Date.now() });
    return res.status(201).json({ ok: true, uploadId, chunkSize: CHUNK_SIZE, totalChunks });
  });

  router.post("/api/telegram/uploads/:uploadId/chunks/:chunkIndex", requireUser, express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const uploadId = safeUploadId(req.params.uploadId);
    const chunkIndex = safeChunkIndex(req.params.chunkIndex);
    if (!uploadId || chunkIndex === null || !Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > CHUNK_SIZE) return res.status(400).json({ ok: false, error: "Invalid chunk." });
    const uploadRef = db.ref(`telegramUploads/${req.telegramUser.uid}/${uploadId}`);
    const uploadSnapshot = await uploadRef.get();
    if (!uploadSnapshot.exists()) return res.status(404).json({ ok: false, error: "Upload not found." });
    const upload = uploadSnapshot.val() || {};
    const totalChunks = safeTotalChunks(upload.totalChunks);
    if (!totalChunks || chunkIndex >= totalChunks) return res.status(400).json({ ok: false, error: "Chunk index is out of range." });
    const existingRef = uploadRef.child(`chunks/${chunkIndex}`);
    const existing = await existingRef.get();
    if (existing.exists()) return res.json({ ok: true, duplicate: true, chunk: existing.val(), uploadId });
    const bots = buildBotPool();
    if (!bots.length) return res.status(503).json({ ok: false, error: "Telegram storage is not configured." });
    const bot = await reserveBot(db, bots);
    try {
      const form = new FormData();
      form.set("chat_id", bot.chatId);
      form.set("caption", `INDO_CHUNK ${uploadId} ${chunkIndex + 1}/${totalChunks}`);
      form.set("document", new Blob([req.body], { type: String(upload.mimeType || "application/octet-stream") }), `${safeFileName(upload.fileName)}.part${String(chunkIndex).padStart(6, "0")}`);
      const message = await telegramCall(bot, "sendDocument", form);
      const document = message?.document;
      if (!document?.file_id) throw new Error("Telegram did not return a document file_id.");
      const chunk = { index: chunkIndex, size: req.body.length, botKey: bot.key, botIndex: bot.index, fileId: String(document.file_id), fileUniqueId: String(document.file_unique_id || ""), messageId: Number(message.message_id || 0), uploadedAt: Date.now() };
      await existingRef.set(chunk);
      const countResult = await uploadRef.child("uploadedChunks").transaction((current) => Number(current || 0) + 1);
      const uploadedChunks = Number(countResult.snapshot.val() || 0);
      await uploadRef.update({ updatedAt: Date.now(), uploadedChunks, status: uploadedChunks >= totalChunks ? "complete" : "uploading" });
      return res.status(201).json({ ok: true, uploadId, chunk, uploadedChunks, totalChunks });
    } catch (error) {
      if (Number(error?.status) === 429) return res.status(503).json({ ok: false, error: "Telegram is busy. Please retry this chunk.", retryAfter: Number(error?.telegramResponse?.parameters?.retry_after || 5) });
      return res.status(502).json({ ok: false, error: error?.message || "Telegram upload failed." });
    } finally {
      await releaseBot(db, bot);
    }
  });

  router.post("/api/telegram/uploads/:uploadId/finalize", requireUser, async (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const uploadId = safeUploadId(req.params.uploadId);
    if (!uploadId) return res.status(400).json({ ok: false, error: "Invalid upload ID." });
    const uploadRef = db.ref(`telegramUploads/${req.telegramUser.uid}/${uploadId}`);
    const snapshot = await uploadRef.get();
    if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Upload not found." });
    const upload = snapshot.val() || {};
    if (String(upload.status || "") === "complete" && upload.videoId) {
      const videoSnapshot = await db.ref(`videos/${upload.videoId}`).get();
      return res.json({ ok: true, video: videoSnapshot.val() || null });
    }
    const totalChunks = safeTotalChunks(upload.totalChunks);
    if (!totalChunks) return res.status(400).json({ ok: false, error: "Invalid upload metadata." });
    const chunks = upload.chunks || {};
    for (let index = 0; index < totalChunks; index += 1) {
      if (!chunks[index]?.fileId) return res.status(409).json({ ok: false, error: `Chunk ${index + 1} is missing.` });
    }
    if (typeof saveVideo !== "function") return res.status(500).json({ ok: false, error: "Video publisher is unavailable." });
    const video = await saveVideo({ db, user: req.telegramUser, upload, streamUrl: `${req.protocol || "https"}://${req.get("host")}/api/media/videos/telegram/${encodeURIComponent(uploadId)}/stream` });
    await uploadRef.update({ status: "complete", videoId: video.id, updatedAt: Date.now() });
    return res.status(201).json({ ok: true, video });
  });

  router.get("/api/telegram/uploads/:uploadId", requireUser, async (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const uploadId = safeUploadId(req.params.uploadId);
    if (!uploadId) return res.status(400).json({ ok: false, error: "Invalid upload ID." });
    const snapshot = await db.ref(`telegramUploads/${req.telegramUser.uid}/${uploadId}`).get();
    if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Upload not found." });
    return res.json({ ok: true, upload: snapshot.val() });
  });

  router.get("/api/media/videos/telegram/:uploadId/stream", async (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const uploadId = safeUploadId(req.params.uploadId);
    if (!uploadId) return res.status(400).json({ ok: false, error: "Invalid upload ID." });
    const rootSnapshot = await db.ref("telegramUploads").get();
    const root = rootSnapshot.val() || {};
    let upload = null;
    for (const uploads of Object.values(root)) {
      if (uploads && uploads[uploadId]) { upload = uploads[uploadId]; break; }
    }
    if (!upload || String(upload.status || "") !== "complete") return res.status(404).json({ ok: false, error: "Video not found." });
    if (String(upload.privacy || "public") === "private") return res.status(403).json({ ok: false, error: "This video is private." });
    const totalSize = Number(upload.size || 0);
    const range = String(req.headers.range || "").trim();
    let start = 0;
    let end = Math.max(0, totalSize - 1);
    if (range.startsWith("bytes=")) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
      if (!match || (!match[1] && !match[2])) return res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
      if (match[1]) start = Number(match[1]);
      end = match[2] ? Number(match[2]) : totalSize - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= totalSize) return res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
      end = Math.min(end, totalSize - 1);
    }
    const chunkSize = Number(upload.chunkSize || CHUNK_SIZE);
    const firstChunk = Math.floor(start / chunkSize);
    const lastChunk = Math.floor(end / chunkSize);
    const partial = Boolean(range);
    res.setHeader("Access-Control-Allow-Origin", "https://yashwanthputtarajegowda.github.io");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type, Accept");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.status(partial ? 206 : 200);
    res.setHeader("Content-Type", String(upload.mimeType || "video/mp4"));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Length", String(end - start + 1));
    if (partial) res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    if (req.method === "HEAD") return res.end();
    try {
      for (let index = firstChunk; index <= lastChunk; index += 1) {
        const data = await getTelegramChunkBuffer(db, upload, index);
        const absoluteChunkStart = index * chunkSize;
        const sliceStart = Math.max(0, start - absoluteChunkStart);
        const sliceEnd = Math.min(data.length, end - absoluteChunkStart + 1);
        if (sliceEnd > sliceStart) res.write(data.subarray(sliceStart, sliceEnd));
      }
      return res.end();
    } catch (error) {
      console.error("Telegram video stream failed:", error?.message || error);
      if (!res.headersSent) return res.status(502).json({ ok: false, error: "Video stream is temporarily unavailable." });
      return res.end();
    }
  });

  return router;
}
