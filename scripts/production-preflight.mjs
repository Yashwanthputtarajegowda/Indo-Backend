const required = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_DATABASE_URL",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "CORS_ORIGINS",
];

const missing = required.filter((key) => !String(process.env[key] || "").trim());
const cors = String(process.env.CORS_ORIGINS || "");
const localhostOnly = cors && cors.split(",").every((origin) => /localhost|127\.0\.0\.1/.test(origin.trim()));

if (missing.length) {
  console.error(`Missing production environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

if (localhostOnly) {
  console.error("CORS_ORIGINS only contains localhost/127.0.0.1; configure the production frontend origin.");
  process.exit(1);
}

console.log("Production environment preflight passed.");
