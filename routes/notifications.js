import express from "express";
import {
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../services/notifications.js";

const REPORT_REASONS = new Set([
  "spam",
  "harassment",
  "hate",
  "violence",
  "sexual",
  "copyright",
  "other",
]);

export function createNotificationsRouter({
  db,
  requireUser,
}) {
  const router = express.Router();

  router.get(
    "/notifications",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res
          .status(503)
          .json({
            ok: false,
            error: "Service unavailable.",
          });
      try {
        const limit = Math.min(
          100,
          Math.max(
            1,
            Number(req.query.limit) || 50,
          ),
        );
        const notifications =
          await listNotifications({
            db,
            uid: user.uid,
            limit,
          });
        return res.json({
          ok: true,
          notifications,
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Could not load notifications.",
        });
      }
    },
  );

  router.get(
    "/notifications/unread-count",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res
          .status(503)
          .json({
            ok: false,
            error: "Service unavailable.",
          });
      try {
        const count =
          await countUnreadNotifications({
            db,
            uid: user.uid,
          });
        return res.json({
          ok: true,
          unreadCount: count,
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Could not load unread notification count.",
        });
      }
    },
  );

  router.post(
    "/notifications/:notificationId/read",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res
          .status(503)
          .json({
            ok: false,
            error: "Service unavailable.",
          });
      const notificationId = String(
        req.params.notificationId || "",
      ).trim();
      if (!notificationId)
        return res
          .status(400)
          .json({
            ok: false,
            error: "Notification ID is required.",
          });
      try {
        await markNotificationRead({
          db,
          uid: user.uid,
          notificationId,
        });
        return res.json({
          ok: true,
          notificationId,
          read: true,
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Could not update notification.",
        });
      }
    },
  );

  router.post(
    "/notifications/read-all",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res
          .status(503)
          .json({
            ok: false,
            error: "Service unavailable.",
          });
      try {
        const markedRead =
          await markAllNotificationsRead({
            db,
            uid: user.uid,
          });
        return res.json({
          ok: true,
          markedRead,
          unreadCount: 0,
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Could not mark notifications as read.",
        });
      }
    },
  );

  router.post(
    "/reports",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;

      if (!db) {
        return res.status(503).json({
          ok: false,
          error: "Service unavailable.",
        });
      }

      const videoId = String(
        req.body?.videoId || "",
      ).trim();
      const reason = String(
        req.body?.reason || "",
      ).trim().toLowerCase();
      const details = String(
        req.body?.details || "",
      )
        .trim()
        .slice(0, 500);

      if (!videoId) {
        return res.status(400).json({
          ok: false,
          error: "Video ID is required.",
        });
      }

      if (!REPORT_REASONS.has(reason)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid report reason.",
        });
      }

      try {
        const videoSnapshot = await db
          .ref("videos")
          .child(videoId)
          .get();

        if (!videoSnapshot.exists()) {
          return res.status(404).json({
            ok: false,
            error: "Video not found.",
          });
        }

        const video = videoSnapshot.val() || {};
        const indexRef = db
          .ref("videoReportIndex")
          .child(videoId)
          .child(user.uid);
        const existing = await indexRef.get();

        if (existing.exists()) {
          return res.json({
            ok: true,
            alreadyReported: true,
            message: "You already reported this video.",
          });
        }

        const reportRef = db.ref("reports").push();
        const report = {
          id: reportRef.key,
          videoId,
          reporterUid: user.uid,
          ownerUid: String(
            video.ownerUid || "",
          ),
          reason,
          details,
          status: "open",
          createdAt: Date.now(),
        };

        await db.ref().update({
          [`reports/${reportRef.key}`]: report,
          [`videoReportIndex/${videoId}/${user.uid}`]:
            reportRef.key,
        });

        return res.status(201).json({
          ok: true,
          alreadyReported: false,
          reportId: reportRef.key,
        });
      } catch (error) {
        console.error("Video report failed:", error);
        return res.status(500).json({
          ok: false,
          error: "Could not submit the report.",
        });
      }
    },
  );

  return router;
}
