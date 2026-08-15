import express from "express";
import { isBlockedEitherWay } from "./social-block.js";
import { createNotification } from "../services/notifications.js";

function clean(value, max = 1000) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function conversationId(firstUid, secondUid) {
  return [firstUid, secondUid].sort().join("_");
}

async function loadUser(db, uid) {
  const snapshot = await db.ref(`users/${uid}`).get();
  return snapshot.exists() ? snapshot.val() || {} : null;
}

export function createMessagesRouter({ db, requireUser }) {
  const router = express.Router();

  async function requireMessagingUsers(req, res) {
    const user = await requireUser(req, res);
    if (!user) return null;

    const targetUid = clean(req.params.targetUid, 200);
    if (!targetUid) {
      res.status(400).json({ ok: false, error: "Target user is required." });
      return null;
    }
    if (targetUid === user.uid) {
      res.status(400).json({ ok: false, error: "You cannot message yourself." });
      return null;
    }
    if (!db) {
      res.status(503).json({
        ok: false,
        error: "Firebase Admin is not configured on the backend.",
      });
      return null;
    }

    const target = await loadUser(db, targetUid);
    if (!target) {
      res.status(404).json({ ok: false, error: "Target profile not found." });
      return null;
    }

    if (
      await isBlockedEitherWay({
        db,
        requesterUid: user.uid,
        ownerUid: targetUid,
      })
    ) {
      res.status(403).json({ ok: false, error: "Messaging is unavailable for this user." });
      return null;
    }

    return { user, target, targetUid };
  }

  router.get("/messages/:targetUid", async (req, res) => {
    try {
      const context = await requireMessagingUsers(req, res);
      if (!context) return;
      const id = conversationId(context.user.uid, context.targetUid);
      const snapshot = await db.ref(`messages/${id}`).limitToLast(200).get();
      const messages = Object.values(snapshot.val() || {}).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      return res.json({
        ok: true,
        conversationId: id,
        messages,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not load messages.",
      });
    }
  });

  router.post("/messages/:targetUid", async (req, res) => {
    try {
      const context = await requireMessagingUsers(req, res);
      if (!context) return;

      const text = clean(req.body?.text);
      if (!text) {
        return res.status(400).json({ ok: false, error: "Message cannot be empty." });
      }

      const id = conversationId(context.user.uid, context.targetUid);
      const ref = db.ref(`messages/${id}`).push();
      const sender = await loadUser(db, context.user.uid);
      const message = {
        id: ref.key,
        conversationId: id,
        senderUid: context.user.uid,
        recipientUid: context.targetUid,
        senderUserId: sender?.username || `@${context.user.uid.slice(0, 8)}`,
        text,
        createdAt: Date.now(),
      };

      await ref.set(message);
      await db.ref(`conversations/${context.user.uid}/${context.targetUid}`).update({
        uid: context.targetUid,
        username: context.target.username || `@${context.targetUid.slice(0, 8)}`,
        name: context.target.name || "Indo User",
        lastMessage: text,
        lastMessageAt: message.createdAt,
        unreadCount: 0,
      });
      await db.ref(`conversations/${context.targetUid}/${context.user.uid}`).update({
        uid: context.user.uid,
        username: sender?.username || `@${context.user.uid.slice(0, 8)}`,
        name: sender?.name || "Indo User",
        lastMessage: text,
        lastMessageAt: message.createdAt,
        unreadCount: Number((await db.ref(`conversations/${context.targetUid}/${context.user.uid}/unreadCount`).get()).val() || 0) + 1,
      });

      await createNotification({
        db,
        recipientUid: context.targetUid,
        type: "message",
        actorUid: context.user.uid,
        actorName: sender?.name || "Indo User",
        actorUserId: sender?.username || "",
        text: "sent you a message",
        targetId: id,
      });

      return res.status(201).json({ ok: true, message });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not send message.",
      });
    }
  });

  router.post("/messages/:targetUid/read", async (req, res) => {
    try {
      const context = await requireMessagingUsers(req, res);
      if (!context) return;
      await db.ref(`conversations/${context.user.uid}/${context.targetUid}/unreadCount`).set(0);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not mark messages as read.",
      });
    }
  });

  router.get("/messages", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: "Firebase Admin is not configured on the backend.",
      });
    }
    try {
      const snapshot = await db.ref(`conversations/${user.uid}`).get();
      const conversations = Object.values(snapshot.val() || {}).sort((a, b) => Number(b.lastMessageAt || 0) - Number(a.lastMessageAt || 0));
      return res.json({ ok: true, conversations });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not load conversations.",
      });
    }
  });

  return router;
}
