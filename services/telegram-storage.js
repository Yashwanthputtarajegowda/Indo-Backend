const BOT_TOKEN = () => String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT_ID = () => String(process.env.TELEGRAM_CHAT_ID || "").trim();

export function telegramStorageConfigured() {
  return Boolean(BOT_TOKEN() && CHAT_ID());
}

async function telegramCall(method, body) {
  const token = BOT_TOKEN();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    { method: "POST", body },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram ${method} failed.`);
  }
  return data.result;
}

async function sendByUrl(method, field, mediaUrl, caption = "") {
  if (!telegramStorageConfigured()) {
    throw new Error("Telegram storage is not configured.");
  }

  const form = new FormData();
  form.set("chat_id", CHAT_ID());
  form.set(field, String(mediaUrl));
  if (caption) form.set("caption", String(caption).slice(0, 1024));
  return telegramCall(method, form);
}

export async function mirrorVideoFromUrl({ mediaUrl, caption = "", fileName = "indo-video" }) {
  const message = await sendByUrl("sendVideo", "video", mediaUrl, caption);
  const video = message?.video;
  if (!video?.file_id) {
    throw new Error("Telegram did not return a video file_id.");
  }
  return {
    storage: "telegram",
    fileId: String(video.file_id),
    fileUniqueId: String(video.file_unique_id || ""),
    messageId: Number(message.message_id || 0),
    fileName: String(fileName),
  };
}

export async function mirrorVideoBuffer({ buffer, caption = "", fileName = "indo-video.mp4" }) {
  if (!telegramStorageConfigured()) {
    throw new Error("Telegram storage is not configured.");
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Video file is empty.");
  }

  const form = new FormData();
  form.set("chat_id", CHAT_ID());
  form.set("video", new Blob([buffer], { type: "video/mp4" }), String(fileName || "indo-video.mp4"));
  if (caption) form.set("caption", String(caption).slice(0, 1024));
  const message = await telegramCall("sendVideo", form);
  const video = message?.video;
  if (!video?.file_id) {
    throw new Error("Telegram did not return a video file_id.");
  }
  return {
    storage: "telegram",
    fileId: String(video.file_id),
    fileUniqueId: String(video.file_unique_id || ""),
    messageId: Number(message.message_id || 0),
    fileName: String(fileName || "indo-video.mp4"),
  };
}

export async function mirrorPhotoFromUrl({ mediaUrl, caption = "" }) {
  const message = await sendByUrl("sendPhoto", "photo", mediaUrl, caption);
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  const photo = photos.at(-1);
  if (!photo?.file_id) {
    throw new Error("Telegram did not return a photo file_id.");
  }
  return {
    storage: "telegram",
    fileId: String(photo.file_id),
    fileUniqueId: String(photo.file_unique_id || ""),
    messageId: Number(message.message_id || 0),
  };
}

export async function getTelegramFileUrl(fileId) {
  if (!telegramStorageConfigured()) {
    throw new Error("Telegram storage is not configured.");
  }

  const form = new FormData();
  form.set("file_id", String(fileId));
  const file = await telegramCall("getFile", form);
  const filePath = String(file?.file_path || "").trim();
  if (!filePath) throw new Error("Telegram file path is missing.");

  // Telegram bot tokens contain ':' and are already valid URL path segments.
  // Do not percent-encode the token here: the Bot API file endpoint expects the
  // literal `bot<TOKEN>/<file_path>` path that also works with direct fetches.
  return `https://api.telegram.org/file/bot${BOT_TOKEN()}/${filePath}`;
}

export async function deleteTelegramMessage(messageId) {
  if (!telegramStorageConfigured()) return false;
  const form = new FormData();
  form.set("chat_id", CHAT_ID());
  form.set("message_id", String(messageId));
  try {
    await telegramCall("deleteMessage", form);
    return true;
  } catch {
    return false;
  }
}
