import express from "express";
import {
  createNotification,
  listNotifications,
  markNotificationRead,
} from "../services/notifications.js";
import { canAccessMedia } from "./social-block.js";

function safeText(value, max = 500) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

const VIDEO_ELIGIBILITY_HOURS = 5000;
const REEL_ELIGIBILITY_HOURS = 1000;
const VIDEO_RATE_PER_1000_VIEWS = 0.5;
const REEL_RATE_PER_1000_VIEWS = 0.1;
const MIN_PAYOUT_USD = 10;

export function createMediaEngagementRouter({
  db,
  requireUser,
}) {
  const router = express.Router();

  router.post(
    "/media/:mediaId/like",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const mediaId = safeText(
        req.params.mediaId,
        120,
      );
      const like = req.body?.like === true;
      if (!mediaId)
        return res
          .status(400)
          .json({
            ok: false,
            error: "Media ID is required.",
          });
      try {
        const mediaRef = db.ref(
          `videos/${mediaId}`,
        );
        const snapshot = await mediaRef.get();
        if (!snapshot.exists())
          return res
            .status(404)
            .json({
              ok: false,
              error: "Media not found.",
            });
        const media = snapshot.val() || {};
        if (
          !(await canAccessMedia({
            db,
            requireUser,
            req,
            res,
            media,
          }))
        )
          return;
        const likeRef = db.ref(
          `videoLikes/${mediaId}/${user.uid}`,
        );
        const wasLiked = Boolean(
          (await likeRef.get()).val(),
        );
        await likeRef.set(like || null);
        const countRef = db.ref(
          `videos/${mediaId}/likes`,
        );
        const result = await countRef.transaction(
          (current) => {
            const value = Math.max(
              0,
              Number(current) || 0,
            );
            if (like === wasLiked) return value;
            return like
              ? value + 1
              : Math.max(0, value - 1);
          },
        );
        if (
          like &&
          !wasLiked &&
          media.ownerUid &&
          media.ownerUid !== user.uid
        ) {
          const actor =
            (
              await db
                .ref(`users/${user.uid}`)
                .get()
            ).val() || {};
          await createNotification({
            db,
            recipientUid: media.ownerUid,
            type: "like",
            actorUid: user.uid,
            actorName: actor.name || "Indo User",
            actorUserId: actor.username || "",
            text: "liked your video",
            targetId: mediaId,
          });
        }
        return res.json({
          ok: true,
          liked: like,
          likes:
            Number(result.snapshot.val()) || 0,
        });
      } catch (error) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              error.message ||
              "Could not update like.",
          });
      }
    },
  );

  router.get(
    "/media/:mediaId/engagement",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const mediaId = safeText(
        req.params.mediaId,
        120,
      );
      try {
        const mediaSnapshot = await db
          .ref(`videos/${mediaId}`)
          .get();
        if (!mediaSnapshot.exists())
          return res
            .status(404)
            .json({
              ok: false,
              error: "Media not found.",
            });
        const media = mediaSnapshot.val() || {};
        if (
          !(await canAccessMedia({
            db,
            requireUser,
            req,
            res,
            media,
          }))
        )
          return;
        const [likeSnapshot, saveSnapshot] =
          await Promise.all([
            db
              .ref(
                `videoLikes/${mediaId}/${user.uid}`,
              )
              .get(),
            db
              .ref(
                `videoSaves/${mediaId}/${user.uid}`,
              )
              .get(),
          ]);
        return res.json({
          ok: true,
          likes: Number(media.likes || 0),
          liked: Boolean(likeSnapshot.val()),
          saved: Boolean(saveSnapshot.val()),
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not load engagement.",
        });
      }
    },
  );

  router.post(
    "/media/:mediaId/save",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const mediaId = safeText(
        req.params.mediaId,
        120,
      );
      const save = req.body?.save === true;
      try {
        const mediaSnapshot = await db
          .ref(`videos/${mediaId}`)
          .get();
        if (!mediaSnapshot.exists())
          return res
            .status(404)
            .json({
              ok: false,
              error: "Media not found.",
            });
        const media = mediaSnapshot.val() || {};
        if (
          !(await canAccessMedia({
            db,
            requireUser,
            req,
            res,
            media,
          }))
        )
          return;
        await db
          .ref(
            `videoSaves/${mediaId}/${user.uid}`,
          )
          .set(save || null);
        return res.json({
          ok: true,
          saved: save,
        });
      } catch (error) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              error.message ||
              "Could not update save.",
          });
      }
    },
  );

  router.post(
    "/media/:mediaId/comments",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const mediaId = safeText(
        req.params.mediaId,
        120,
      );
      const text = safeText(req.body?.text, 500);
      if (!text)
        return res
          .status(400)
          .json({
            ok: false,
            error: "Comment cannot be empty.",
          });
      try {
        const mediaSnapshot = await db
          .ref(`videos/${mediaId}`)
          .get();
        if (!mediaSnapshot.exists())
          return res
            .status(404)
            .json({
              ok: false,
              error: "Media not found.",
            });
        const media = mediaSnapshot.val() || {};
        if (
          !(await canAccessMedia({
            db,
            requireUser,
            req,
            res,
            media,
          }))
        )
          return;
        const profile =
          (
            await db
              .ref(`users/${user.uid}`)
              .get()
          ).val() || {};
        const ref = db
          .ref(`videoComments/${mediaId}`)
          .push();
        const comment = {
          id: ref.key,
          mediaId,
          uid: user.uid,
          username:
            profile.username ||
            `@${user.uid.slice(0, 8)}`,
          text,
          createdAt: Date.now(),
        };
        await ref.set(comment);
        if (
          media.ownerUid &&
          media.ownerUid !== user.uid
        )
          await createNotification({
            db,
            recipientUid: media.ownerUid,
            type: "comment",
            actorUid: user.uid,
            actorName:
              profile.name || "Indo User",
            actorUserId: comment.username,
            text: "commented on your video",
            targetId: mediaId,
          });
        return res
          .status(201)
          .json({ ok: true, comment });
      } catch (error) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              error.message ||
              "Could not add comment.",
          });
      }
    },
  );

  router.get(
    "/media/:mediaId/comments",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const mediaId = safeText(
        req.params.mediaId,
        120,
      );
      try {
        const mediaSnapshot = await db
          .ref(`videos/${mediaId}`)
          .get();
        if (!mediaSnapshot.exists())
          return res
            .status(404)
            .json({
              ok: false,
              error: "Media not found.",
            });
        const media = mediaSnapshot.val() || {};
        if (
          !(await canAccessMedia({
            db,
            requireUser,
            req,
            res,
            media,
          }))
        )
          return;
        const snapshot = await db
          .ref(`videoComments/${mediaId}`)
          .limitToLast(100)
          .get();
        const comments = Object.values(
          snapshot.val() || {},
        ).sort(
          (a, b) =>
            Number(a.createdAt || 0) -
            Number(b.createdAt || 0),
        );
        return res.json({ ok: true, comments });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not load comments.",
        });
      }
    },
  );

  router.get(
    "/notifications",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      try {
        return res.json({
          ok: true,
          notifications: await listNotifications({
            db,
            uid: user.uid,
            limit: 100,
          }),
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not load notifications.",
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
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      try {
        await markNotificationRead({
          db,
          uid: user.uid,
          notificationId: safeText(
            req.params.notificationId,
            120,
          ),
        });
        return res.json({ ok: true });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not mark notification as read.",
        });
      }
    },
  );

  router.post(
    "/earnings/watch-progress",
    async (req, res) => {
      const viewer = await requireUser(req, res);
      if (!viewer) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const mediaId = safeText(
        req.body?.mediaId,
        120,
      );
      const seconds = Math.min(
        15,
        Math.max(
          0,
          Number(req.body?.seconds) || 0,
        ),
      );
      if (!mediaId || seconds <= 0)
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Media ID and watch seconds are required.",
          });
      try {
        const media =
          (
            await db
              .ref(`videos/${mediaId}`)
              .get()
          ).val() || {};
        const ownerUid = String(
          media.ownerUid || "",
        );
        if (!ownerUid || ownerUid === viewer.uid)
          return res.json({
            ok: true,
            counted: false,
          });
        if (
          !(await canAccessMedia({
            db,
            requireUser,
            req,
            res,
            media,
          }))
        )
          return;
        const typeKey =
          media.mediaType === "reel"
            ? "reel"
            : "video";
        const result = await db
          .ref(
            `users/${ownerUid}/earning/watchSeconds/${typeKey}`,
          )
          .transaction(
            (current) =>
              (Number(current) || 0) + seconds,
          );
        return res.json({
          ok: true,
          counted: true,
          type: typeKey,
          watchSeconds:
            Number(result.snapshot.val()) || 0,
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not record watch progress.",
        });
      }
    },
  );

  router.get(
    "/earnings/status",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      try {
        const earning =
          (
            await db
              .ref(`users/${user.uid}/earning`)
              .get()
          ).val() || {};
        const videoWatchSeconds = Number(
          earning.watchSeconds?.video || 0,
        );
        const reelWatchSeconds = Number(
          earning.watchSeconds?.reel || 0,
        );
        const videoWatchHours =
          videoWatchSeconds / 3600;
        const reelWatchHours =
          reelWatchSeconds / 3600;
        const eligible =
          videoWatchHours >=
            VIDEO_ELIGIBILITY_HOURS &&
          reelWatchHours >=
            REEL_ELIGIBILITY_HOURS;
        return res.json({
          ok: true,
          eligible,
          earningEnabled: Boolean(
            earning.enabled,
          ),
          videoWatchSeconds,
          reelWatchSeconds,
          videoWatchHours,
          reelWatchHours,
          requirements: {
            videoWatchHours:
              VIDEO_ELIGIBILITY_HOURS,
            reelWatchHours:
              REEL_ELIGIBILITY_HOURS,
          },
          rates: {
            videoPer1000Views:
              VIDEO_RATE_PER_1000_VIEWS,
            reelPer1000Views:
              REEL_RATE_PER_1000_VIEWS,
          },
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not load earning status.",
        });
      }
    },
  );

  router.post(
    "/earnings/toggle",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const enabled = req.body?.enabled === true;
      try {
        const earningRef = db.ref(
          `users/${user.uid}/earning`,
        );
        const earning =
          (await earningRef.get()).val() || {};
        const eligible =
          Number(
            earning.watchSeconds?.video || 0,
          ) /
            3600 >=
            VIDEO_ELIGIBILITY_HOURS &&
          Number(
            earning.watchSeconds?.reel || 0,
          ) /
            3600 >=
            REEL_ELIGIBILITY_HOURS;
        if (enabled && !eligible)
          return res.status(403).json({
            ok: false,
            error:
              "Earning is not eligible yet. Complete both watch-hour requirements first.",
            eligible: false,
          });
        await earningRef.update({
          enabled,
          enabledAt: enabled ? Date.now() : null,
          videoRatePer1000Views:
            VIDEO_RATE_PER_1000_VIEWS,
          reelRatePer1000Views:
            REEL_RATE_PER_1000_VIEWS,
        });
        return res.json({
          ok: true,
          earningEnabled: enabled,
          eligible,
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not update earning setting.",
        });
      }
    },
  );

  router.get(
    "/earnings/summary",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      try {
        const earning =
          (
            await db
              .ref(`users/${user.uid}/earning`)
              .get()
          ).val() || {};
        const snapshot = await db
          .ref("videos")
          .orderByChild("ownerUid")
          .equalTo(user.uid)
          .get();
        const ownVideos = Object.values(
          snapshot.val() || {},
        );
        const videoViews = ownVideos
          .filter(
            (item) =>
              (item.mediaType || "video") ===
              "video",
          )
          .reduce(
            (sum, item) =>
              sum +
              Math.max(
                0,
                Number(item.views) || 0,
              ),
            0,
          );
        const reelViews = ownVideos
          .filter(
            (item) => item.mediaType === "reel",
          )
          .reduce(
            (sum, item) =>
              sum +
              Math.max(
                0,
                Number(item.views) || 0,
              ),
            0,
          );
        const grossRevenue =
          (videoViews / 1000) *
            VIDEO_RATE_PER_1000_VIEWS +
          (reelViews / 1000) *
            REEL_RATE_PER_1000_VIEWS;
        const payableRevenue = earning.enabled
          ? grossRevenue
          : 0;
        await db
          .ref(
            `users/${user.uid}/earning/summary`,
          )
          .update({
            videoViews,
            reelViews,
            grossRevenue,
            payableRevenue,
            updatedAt: Date.now(),
          });
        return res.json({
          ok: true,
          videoViews,
          reelViews,
          grossRevenue,
          payableRevenue,
          earningEnabled: Boolean(
            earning.enabled,
          ),
          rates: {
            videoPer1000Views:
              VIDEO_RATE_PER_1000_VIEWS,
            reelPer1000Views:
              REEL_RATE_PER_1000_VIEWS,
          },
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not calculate earning summary.",
        });
      }
    },
  );

  router.get("/wallet", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res.status(503).json({
        ok: false,
        error:
          "Firebase Admin is not configured on the backend.",
      });
    try {
      const [earningSnapshot, payoutSnapshot] =
        await Promise.all([
          db
            .ref(`users/${user.uid}/earning`)
            .get(),
          db
            .ref(`users/${user.uid}/payouts`)
            .limitToLast(50)
            .get(),
        ]);
      const earning = earningSnapshot.val() || {};
      const summary = earning.summary || {};
      const payouts = Object.values(
        payoutSnapshot.val() || {},
      ).sort(
        (a, b) =>
          Number(b.createdAt || 0) -
          Number(a.createdAt || 0),
      );
      return res.json({
        ok: true,
        balance: Number(
          summary.payableRevenue || 0,
        ),
        earningEnabled: Boolean(earning.enabled),
        minimumPayoutUsd: MIN_PAYOUT_USD,
        payouts,
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            "Could not load wallet.",
        });
    }
  });

  router.post(
    "/wallet/payout-request",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const method =
        req.body?.method === "bank"
          ? "bank"
          : "manual";
      const requestedAmount = Number(
        req.body?.amount || 0,
      );
      if (
        !Number.isFinite(requestedAmount) ||
        requestedAmount <= 0
      )
        return res
          .status(400)
          .json({
            ok: false,
            error: "Enter a valid payout amount.",
          });
      try {
        const walletSnapshot = await db
          .ref(
            `users/${user.uid}/earning/summary`,
          )
          .get();
        const balance = Number(
          walletSnapshot.val()?.payableRevenue ||
            0,
        );
        if (balance < MIN_PAYOUT_USD)
          return res.status(400).json({
            ok: false,
            error: `Minimum payout is $${MIN_PAYOUT_USD.toFixed(2)}.`,
          });
        if (requestedAmount > balance)
          return res.status(400).json({
            ok: false,
            error:
              "Requested amount is greater than your available balance.",
          });
        const payoutRef = db
          .ref(`users/${user.uid}/payouts`)
          .push();
        const payout = {
          id: payoutRef.key,
          amount: Number(
            requestedAmount.toFixed(2),
          ),
          method,
          status: "pending",
          createdAt: Date.now(),
        };
        await payoutRef.set(payout);
        return res
          .status(201)
          .json({ ok: true, payout });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not create payout request.",
        });
      }
    },
  );

  return router;
}
