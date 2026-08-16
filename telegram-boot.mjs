import express from "express";
import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { createTelegramChunkRouter, getTelegramChunkConfig } from "./services/telegram-chunk-storage.js";

if (admin.apps.length === 0) {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || "indo-174f0").trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const databaseURL = String(
    process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com",
  ).trim();
  if (clientEmail && privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      databaseURL,
    });
  }
}

const originalListen = express.application.listen;
if (!express.application.__indoTelegramPatched) {
  express.application.__indoTelegramPatched = true;
  express.application.listen = function indoTelegramListen(...args) {
    if (!this.__indoTelegramRoutesAttached) {
      const app = this;
      const firebaseApp = admin.apps.length ? admin.app() : null;
      const db = firebaseApp
        ? getDatabaseWithUrl(
            String(process.env.FIREBASE_DATABASE_URL || "https://indo-174f0-default-rtdb.firebaseio.com").trim(),
            firebaseApp,
          )
        : null;
      const auth = firebaseApp ? admin.auth(firebaseApp) : null;
      const router = createTelegramChunkRouter({ express, db, auth });
      app.use(router);
      app.get("/api/telegram/storage-health", (_req, res) => {
        res.json({ ok: true, ...getTelegramChunkConfig() });
      });
      app.__indoTelegramRoutesAttached = true;
      console.log("Telegram chunk storage enabled.", getTelegramChunkConfig());
    }
    return originalListen.apply(this, args);
  };
}
