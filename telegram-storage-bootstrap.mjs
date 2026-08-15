import "dotenv/config";
import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import {
  mirrorPhotoFromUrl,
  mirrorVideoFromUrl,
  telegramStorageConfigured,
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

  const response = express.response;
  const originalJson = response.json;

  response.json = async function telegramAwareJson(payload) {
    try {
      const requestPath = String(this.req?.path || "");

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
