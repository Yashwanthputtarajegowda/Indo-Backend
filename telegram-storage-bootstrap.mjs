import "dotenv/config";
import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { Readable } from "node:stream";
import {
  mirrorPhotoFromUrl,
  mirrorVideoFromUrl,
  telegramStorageConfigured,
  getTelegramFileUrl,
} from "./services/telegram-storage.js";

const enabled =
  String(process.env.TELEGRAM_MIRROR_ENABLED || "true")
    .trim()
    .toLowerCase() !== "false";

if (!enabled || !telegramStorageConfigured()) {
  // Keep the existing Cloudinary flow untouched until Telegram secrets are configured.
} else {
  const DATABASE_URL =
    process.env.FIREBASE_DATABASE_URL ||
    "https://indo-174f0-default-rtdb.firebaseio.com";

  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
        databaseURL: DATABASE_URL,
      });
    }
  }

  const db = admin.apps.length
    ? getDatabaseWithUrl(DATABASE_URL, admin.app())
    : null;

  // Install a first-class streaming middleware before the normal API routes.
  // Videos that have a Telegram file reference are served from Telegram via the
  // backend. The Telegram bot token never reaches the browser.
  const originalUse = express.application.use;
  express.application.use = function telegramStreamUse(...args) {
    if (!this.__indoTelegramStreamInstalled) {
      this.__indoTelegramStreamInstalled = true;
      originalUse.call(this, async (req, res, next) => {
        const match = String(req.path || "").match(/^\/api\/media\/videos\/([^/]+)\/stream$/);
        if (!match || !db) return next();

        const videoId = decodeURIComponent(match[1]);
        try {
          const snapshot = await db.ref(`videos/${videoId}`).get();
          if (!snapshot.exists()) return res.status(404).json({ ok: false, error: "Video not found." });

          const video = snapshot.val() || {};
          const telegram = video.telegram || video.telegramStorage || {};
          const fileId = String(telegram.fileId || "").trim();
          if (!fileId) return next();

          const fileUrl = await getTelegramFileUrl(fileId);
          const headers = {};
          const range = String(req.headers.range || "").trim();
          if (range) headers.Range = range;

          const upstream = await fetch(fileUrl, { headers });
          if (!upstream.ok || !upstream.body) {
            return res.status(upstream.status || 502).json({
              ok: false,
              error: "Telegram media could not be streamed.",
            });
          }

          res.status(upstream.status === 206 ? 206 : 200);
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Cache-Control", "private, max-age=30");
          res.setHeader(
            "Content-Type",
            upstream.headers.get("content-type") || "video/mp4",
          );

          for (const headerName of ["content-length", "content-range", "content-disposition"]) {
            const value = upstream.headers.get(headerName);
            if (value) res.setHeader(headerName, value);
          }

          Readable.fromWeb(upstream.body).pipe(res);
        } catch (error) {
          console.warn("Telegram video stream failed:", error?.message || error);
          if (!res.headersSent) {
            return res.status(502).json({ ok: false, error: "Telegram media could not be streamed." });
          }
          res.destroy(error);
        }
      });
    }

    return originalUse.apply(this, args);
  };

  const response = express.response;
  const originalJson = response.json;

  response.json = async function telegramAwareJson(payload) {
    try {
      const requestPath = String(this.req?.path || "");

      if (
        db &&
        payload?.ok &&
        requestPath === "/api/media/videos" &&
        Array.isArray(payload.videos)
      ) {
        const host = this.req?.get?.("host") || "";
        const proto = this.req?.protocol || "https";
        const baseUrl = host ? `${proto}://${host}` : "";
        payload.videos = payload.videos.map((video) => {
          if (!video || typeof video !== "object") return video;
          const telegram = video.telegram || video.telegramStorage;
          if (!telegram?.fileId || !video.id || !baseUrl) return video;
          const streamUrl = `${baseUrl}/api/media/videos/${encodeURIComponent(video.id)}/stream`;
          return {
            ...video,
            secureUrl: streamUrl,
            videoUrl: streamUrl,
            telegramPlayback: streamUrl,
          };
        });
      }

      if (
        db &&
        payload?.ok &&
        requestPath === "/api/media/videos" &&
        payload.video?.id &&
        payload.video?.secureUrl
      ) {
        try {
          const mirror = await mirrorVideoFromUrl({
            mediaUrl: payload.video.secureUrl,
            caption: payload.video.caption || payload.video.title || "Indo media",
            fileName: payload.video.title || payload.video.id,
          });

          await db.ref(`videos/${payload.video.id}`).update({
            telegramStorage: mirror,
            storageMirrorUpdatedAt: Date.now(),
          });

          payload.video = {
            ...payload.video,
            telegramStorage: mirror,
          };
        } catch (error) {
          console.warn(
            "Telegram video mirror skipped:",
            error?.message || error,
          );
        }
      }

      if (
        db &&
        payload?.ok &&
        requestPath === "/api/stories" &&
        payload.story?.id &&
        payload.story?.secureUrl
      ) {
        try {
          const mirror = await mirrorPhotoFromUrl({
            mediaUrl: payload.story.secureUrl,
            caption: payload.story.name || payload.story.username || "Indo story",
          });

          await db.ref(`stories/${payload.story.id}`).update({
            telegramStorage: mirror,
            storageMirrorUpdatedAt: Date.now(),
          });

          payload.story = {
            ...payload.story,
            telegramStorage: mirror,
          };
        } catch (error) {
          console.warn(
            "Telegram story mirror skipped:",
            error?.message || error,
          );
        }
      }
    } catch (error) {
      console.warn(
        "Telegram storage mirror hook failed:",
        error?.message || error,
      );
    }

    return originalJson.call(this, payload);
  };
}
