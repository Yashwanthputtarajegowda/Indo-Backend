const TECHNICAL_ERROR_PATTERNS = [
  /firebase/i,
  /cloudinary/i,
  /database/i,
  /stack/i,
  /trace/i,
  /typeerror/i,
  /referenceerror/i,
  /syntaxerror/i,
  /econn/i,
  /etimedout/i,
  /socket/i,
  /internal server/i,
  /request failed/i,
  /fetch failed/i,
  /at\s+\w+\s+\(/i,
];

function sanitizeErrorText(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return text;
  if (TECHNICAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
    return "Request could not be completed.";
  }
  return text.length > 240 ? "Request could not be completed." : text;
}

const originalJson = typeof Response !== "undefined" ? Response.prototype.json : null;

export function sanitizeErrorPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (payload.ok !== false && payload.error === undefined) return payload;

  const result = { ...payload };
  if (typeof result.error === "string") {
    result.error = sanitizeErrorText(result.error);
  } else if (result.error && typeof result.error === "object") {
    result.error = "Request could not be completed.";
  }

  for (const key of ["stack", "trace", "details", "debug", "cause"]) {
    if (key in result) delete result[key];
  }
  return result;
}

const expressResponsePrototype = originalJson && originalJson.call
  ? null
  : null;

// This module is loaded before Express bootstraps the app. The actual
// response guard is installed by monkey-patching Express lazily below.
import express from "express";
const originalSendJson = express.response.json;
express.response.json = function secureJson(payload) {
  return originalSendJson.call(this, sanitizeErrorPayload(payload));
};

const originalEnd = express.response.end;
express.response.end = function secureEnd(chunk, encoding, callback) {
  return originalEnd.call(this, chunk, encoding, callback);
};
