import express from "express";

// Cloud Run / reverse proxies terminate TLS before Node sees the request.
// Trust forwarded protocol so generated Telegram stream URLs stay HTTPS.
const originalListen = express.application.listen;
if (!express.application.__indoPlaybackProxyFix) {
  express.application.__indoPlaybackProxyFix = true;
  express.application.listen = function indoPlaybackProxyFixListen(...args) {
    this.set("trust proxy", true);
    return originalListen.apply(this, args);
  };
}

// Telegram's Bot API/file CDN can transiently return 429/5xx while a video
// stream is being read. Retry only idempotent playback calls; never retry
// sendDocument, because retrying an upload can create duplicate chunks.
const originalFetch = globalThis.fetch.bind(globalThis);
const RETRIES = 3;
const RETRY_DELAYS_MS = [350, 900, 1800];

function isTelegramPlaybackRequest(input, init) {
  try {
    const url = typeof input === "string" ? input : input?.url;
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    if (method === "GET") return String(url || "").includes("api.telegram.org/file/bot");
    if (method === "POST") return String(url || "").includes("api.telegram.org/bot") && String(url || "").endsWith("/getFile");
    return false;
  } catch {
    return false;
  }
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

globalThis.fetch = async function indoTelegramFetch(input, init = {}) {
  if (!isTelegramPlaybackRequest(input, init)) return originalFetch(input, init);

  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await originalFetch(input, { ...init, signal: controller.signal });
      if (!retryableStatus(response.status) || attempt === RETRIES) return response;
      await response.arrayBuffer().catch(() => {});
    } catch (error) {
      lastError = error;
      if (attempt === RETRIES) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt] || RETRY_DELAYS_MS.at(-1)));
  }
  throw lastError || new Error("Telegram playback request failed.");
};
