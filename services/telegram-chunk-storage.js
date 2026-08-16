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
    const chatId = numberedChat || (index === 1 ? env("TELEGRAM_CHAT_ID") : "");
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

export function getTelegramChunkConfig() {
  const bots = buildBotPool();
  return { chunkSize: CHUNK_SIZE, botCount: bots.length, configured: bots.length > 0 };
}

export function createTelegramChunkRouter({ express, db, auth }) {
  const router = express.Router();
  const requireUser = async (req, res, next) => {
    if (!auth) return res.status(503).json({ ok: false, error: "Authentication service is unavailable." });
    const header = String(req.headers.authorization || "");
    if (!/^Bearer\s+\S+$/i.test(header)) return res.status(401).json({ ok: false, error: "Authentication required." });
    const token = header.replace(/^Bearer\s+/i, "").trim();
    try {
      req.telegramUser = await auth.verifyIdToken(token, true);
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
    if (!totalChunks || !Number.isFinite(size) || size <= 0 || size > 20 * 1024 * 1024 * 1024) return res.status(400).json({ ok: false, error: "Invalid upload metadata." });
    const uploadRef = db.ref(`telegramUploads/${req.telegramUser.uid}`).push();
    const uploadId = uploadRef.key;
    await uploadRef.set({ uploadId, ownerUid: req.telegramUser.uid, fileName, mimeType, size, totalChunks, chunkSize: CHUNK_SIZE, uploadedChunks: 0, status: "uploading", createdAt: Date.now(), updatedAt: Date.now() });
    return res.status(201).json({ ok: true, uploadId, chunkSize: CHUNK_SIZE, totalChunks });
  });

  router.post(
    "/api/telegram/uploads/:uploadId/chunks/:chunkIndex",
    requireUser,
    express.raw({ type: "application/octet-stream", limit: "2mb" }),
    async (req, res) => {
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
    },
  );

  router.get("/api/telegram/uploads/:uploadId", requireUser, async (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const uploadId = safeUploadId(req.params.uploadId);
    if (!uploadId) return res.status(400).json({ ok: false, error: "Invalid upload ID." });
    const snapshot = await db.ref(`telegramUploads/${req.telegramUser.uid}/${uploadId}`).get();
    if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Upload not found." });
    return res.json({ ok: true, upload: snapshot.val() });
  });

  router.get("/api/telegram/uploads/:uploadId/chunks/:chunkIndex", requireUser, async (req, res) => {
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });
    const uploadId = safeUploadId(req.params.uploadId);
    const chunkIndex = safeChunkIndex(req.params.chunkIndex);
    if (!uploadId || chunkIndex === null) return res.status(400).json({ ok: false, error: "Invalid chunk request." });
    const chunkSnapshot = await db.ref(`telegramUploads/${req.telegramUser.uid}/${uploadId}/chunks/${chunkIndex}`).get();
    if (!chunkSnapshot.exists()) return res.status(404).json({ ok: false, error: "Chunk not found." });
    const chunk = chunkSnapshot.val() || {};
    const uploadSnapshot = await db.ref(`telegramUploads/${req.telegramUser.uid}/${uploadId}`).get();
    if (!uploadSnapshot.exists()) return res.status(404).json({ ok: false, error: "Upload not found." });
    const upload = uploadSnapshot.val() || {};
    const bots = buildBotPool();
    const bot = getBotByKey(bots, chunk.botKey);
    if (!bot) return res.status(503).json({ ok: false, error: "The Telegram bot that owns this chunk is not configured." });
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
      res.status(200);
      res.setHeader("Content-Type", String(upload.mimeType || "application/octet-stream"));
      res.setHeader("Content-Length", String(data.length));
      res.setHeader("Content-Disposition", `inline; filename="${safeFileName(upload.fileName)}.part${String(chunkIndex).padStart(6, "0")}"`);
      res.setHeader("X-Indo-Upload-Id", uploadId);
      res.setHeader("X-Indo-Chunk-Index", String(chunkIndex));
      return res.send(data);
    } catch (error) {
      return res.status(502).json({ ok: false, error: error?.message || "Telegram download failed." });
    } finally {
      await releaseBot(db, bot);
    }
  });

  return router;
}
