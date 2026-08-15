import express from "express";
import { createNotification } from "../services/notifications.js";

function clean(value, max = 500) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

async function blockedEitherWay(
  db,
  requesterUid,
  ownerUid,
) {
  if (
    !requesterUid ||
    !ownerUid ||
    requesterUid === ownerUid
  )
    return false;
  const [a, b] = await Promise.all([
    db
      .ref(
        `users/${requesterUid}/blocked/${ownerUid}`,
      )
      .get(),
    db
      .ref(
        `users/${ownerUid}/blocked/${requesterUid}`,
      )
      .get(),
  ]);
  return a.exists() || b.exists();
}

async function canAccessMedia({
  db,
  user,
  media,
}) {
  const ownerUid = String(media.ownerUid || "");
  if (!ownerUid) return false;
  if (
    await blockedEitherWay(db, user.uid, ownerUid)
  )
    return false;
  if (user.uid === ownerUid) return true;
  const owner =
    (
      await db.ref(`users/${ownerUid}`).get()
    ).val() || {};
  if (
    (owner.accountType || "public") !== "private"
  )
    return true;
  const follower = await db
    .ref(
      `users/${ownerUid}/followers/${user.uid}`,
    )
    .get();
  return follower.exists();
}

export function createMediaPrivacyRouter({
  db,
  requireUser,
}) {
  const router = express.Router();

  async function loadAllowedMedia(req, res) {
    const user = await requireUser(req, res);
    if (!user || !db) return null;
    const mediaId = clean(
      req.params.mediaId,
      120,
    );
    if (!mediaId) {
      res
        .status(400)
        .json({
          ok: false,
          error: "Media ID is required.",
        });
      return null;
    }
    const snapshot = await db
      .ref(`videos/${mediaId}`)
      .get();
    if (!snapshot.exists()) {
      res
        .status(404)
        .json({
          ok: false,
          error: "Media not found.",
        });
      return null;
    }
    const media = snapshot.val() || {};
    if (
      !(await canAccessMedia({ db, user, media }))
    ) {
      res
        .status(403)
        .json({
          ok: false,
          error:
            "You do not have access to this media.",
        });
      return null;
    }
    return { user, mediaId, media };
  }

  router.post(
    "/media/:mediaId/like",
    async (req, res, next) => {
      const route = await loadAllowedMedia(
        req,
        res,
      ).catch(() => null);
      if (!route) return;
      const { user, mediaId, media } = route;
      const like = req.body?.like === true;
      try {
        const likeRef = db.ref(
          `videoLikes/${mediaId}/${user.uid}`,
        );
        const wasLiked = Boolean(
          (await likeRef.get()).val(),
        );
        if (like === wasLiked)
          return res.json({
            ok: true,
            liked: like,
            likes: Number(media.likes || 0),
          });
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
            return like
              ? value + 1
              : Math.max(0, value - 1);
          },
        );
        if (like && media.ownerUid !== user.uid) {
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
        return next(error);
      }
    },
  );

  router.get(
    "/media/:mediaId/engagement",
    async (req, res, next) => {
      const route = await loadAllowedMedia(
        req,
        res,
      ).catch(() => null);
      if (!route) return;
      const { user, mediaId, media } = route;
      try {
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
        return next(error);
      }
    },
  );

  router.post(
    "/media/:mediaId/save",
    async (req, res, next) => {
      const route = await loadAllowedMedia(
        req,
        res,
      ).catch(() => null);
      if (!route) return;
      const { user, mediaId } = route;
      const save = req.body?.save === true;
      try {
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
        return next(error);
      }
    },
  );

  router.post(
    "/media/:mediaId/comments",
    async (req, res, next) => {
      const route = await loadAllowedMedia(
        req,
        res,
      ).catch(() => null);
      if (!route) return;
      const { user, mediaId, media } = route;
      const text = clean(req.body?.text, 500);
      if (!text)
        return res
          .status(400)
          .json({
            ok: false,
            error: "Comment cannot be empty.",
          });
      try {
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
        if (media.ownerUid !== user.uid) {
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
        }
        return res
          .status(201)
          .json({ ok: true, comment });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.get(
    "/media/:mediaId/comments",
    async (req, res, next) => {
      const route = await loadAllowedMedia(
        req,
        res,
      ).catch(() => null);
      if (!route) return;
      const { mediaId } = route;
      try {
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
        return next(error);
      }
    },
  );

  return router;
}
