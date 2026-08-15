import admin from "firebase-admin";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { migrateAllUsersToCanonical } from "../services/user-canonical.js";

const productionOrigin = "https://yashwanthputtarajegowda.github.io";
const configured = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
process.env.CORS_ORIGINS = [...new Set([...configured, productionOrigin])].join(
  ",",
);

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_PROJECT_ID || "indo-174f0";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return null;
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL:
      process.env.FIREBASE_DATABASE_URL ||
      "https://indo-174f0-default-rtdb.firebaseio.com",
  });
}

const app = initFirebase();
if (app) {
  const db = getDatabaseWithUrl(
    process.env.FIREBASE_DATABASE_URL ||
      "https://indo-174f0-default-rtdb.firebaseio.com",
    app,
  );
  const version = Number(
    (await db.ref("system/canonicalSchemaVersion/version").get()).val() || 0,
  );
  if (version < 3) {
    const result = await migrateAllUsersToCanonical({ db });
    console.log(
      `[canonical-migration] migrated ${result.users} users to version 3`,
    );
  } else {
    console.log(`[canonical-migration] version ${version} already active`);
  }
}

await import("../server.js");
