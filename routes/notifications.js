import express from "express";
import {
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../services/notifications.js";

export function createNotificationsRouter({ db, requireUser }) {
  const router = express.Router();

  router.get("/notifications", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res.status(503).json({ ok: false, error: "Service unavailable." });
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const notifications = await listNotifications({
        db,
        uid: user.uid,
        limit,
      });
      return res.json({ ok: true, notifications });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Could not load notifications.",
      });
    }
  });

  router.get("/notifications/unread-count", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res.status(503).json({ ok: false, error: "Service unavailable." });
    try {
      const count = await countUnreadNotifications({ db, uid: user.uid });
      return res.json({ ok: true, unreadCount: count });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Could not load unread notification count.",
      });
    }
  });

  router.post("/notifications/:notificationId/read", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res.status(503).json({ ok: false, error: "Service unavailable." });
    const notificationId = String(req.params.notificationId || "").trim();
    if (!notificationId)
      return res
        .status(400)
        .json({ ok: false, error: "Notification ID is required." });
    try {
      await markNotificationRead({ db, uid: user.uid, notificationId });
      return res.json({ ok: true, notificationId, read: true });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Could not update notification.",
      });
    }
  });

  router.post("/notifications/read-all", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res.status(503).json({ ok: false, error: "Service unavailable." });
    try {
      const markedRead = await markAllNotificationsRead({ db, uid: user.uid });
      return res.json({ ok: true, markedRead, unreadCount: 0 });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "Could not mark notifications as read.",
      });
    }
  });

  return router;
}
