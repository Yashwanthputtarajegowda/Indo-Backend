import express from "express";
import { respondToFollowRequest } from "../services/social-follow.js";

export function createFollowRequestsRouter({ db, requireUser }) {
  const router = express.Router();

  router.get("/social/follow-requests", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res
        .status(503)
        .json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });
    try {
      const [incomingSnapshot, outgoingSnapshot] = await Promise.all([
        db.ref(`users/${user.uid}/followRequests`).get(),
        db.ref(`users/${user.uid}/sentFollowRequests`).get(),
      ]);
      return res.json({
        ok: true,
        incoming: Object.values(incomingSnapshot.val() || {}),
        outgoing: Object.values(outgoingSnapshot.val() || {}),
      });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error: error.message || "Could not load follow requests.",
        });
    }
  });

  router.post("/social/follow-requests/:requesterUid", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res
        .status(503)
        .json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });
    const requesterUid = String(req.params.requesterUid || "").trim();
    const accept = req.body?.accept === true;
    if (!requesterUid)
      return res
        .status(400)
        .json({ ok: false, error: "Requester is required." });
    try {
      const result = await respondToFollowRequest({
        db,
        ownerUid: user.uid,
        requesterUid,
        accept,
      });
      return res.json(result);
    } catch (error) {
      return res
        .status(400)
        .json({
          ok: false,
          error: error.message || "Could not respond to follow request.",
        });
    }
  });

  return router;
}
