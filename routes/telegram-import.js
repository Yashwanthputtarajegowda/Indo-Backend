import express from "express";

const TELEGRAM_IMPORT_ENABLED =
  String(process.env.TELEGRAM_IMPORT_ENABLED || "false").trim().toLowerCase() === "true";

export function createTelegramImportRouter({ requireUser }) {
  const router = express.Router();

  router.post("/media/import-telegram", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;

    if (!TELEGRAM_IMPORT_ENABLED) {
      return res.status(403).json({
        ok: false,
        disabled: true,
        error: "Telegram import is disabled by admin.",
      });
    }

    return res.status(501).json({
      ok: false,
      error: "Telegram import is enabled but the media resolver is not configured yet.",
    });
  });

  return router;
}
