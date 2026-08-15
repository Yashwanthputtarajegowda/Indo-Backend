const productionOrigin = "https://yashwanthputtarajegowda.github.io";
const configured = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

process.env.CORS_ORIGINS = [...new Set([...configured, productionOrigin])].join(",");

await import("./start-production.migration-helper.mjs");
