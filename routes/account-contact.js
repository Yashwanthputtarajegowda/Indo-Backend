import express from "express";
import {
  createCloudinarySignature,
  getCloudinaryConfig,
} from "../services/cloudinary-signature.js";

function publicProfile(profile = {}) {
  const canonical =
    profile.profile &&
    typeof profile.profile === "object"
      ? profile.profile
      : profile;
  const source = { ...profile, ...canonical };
  return {
    uid: source.uid || "",
    userId:
      source.username || source.userId || "",
    name:
      source.name ||
      source.displayName ||
      "Indo User",
    bio: source.bio || "",
    location: source.location || "",
    avatarUrl:
      source.avatarUrl ||
      source.photoURL ||
      source.photoUrl ||
      "",
    photoURL:
      source.photoURL ||
      source.avatarUrl ||
      source.photoUrl ||
      "",
    accountType:
      source.accountType === "private"
        ? "private"
        : "public",
    followersCount: Number(
      source.followersCount ||
        source.stats?.followersCount ||
        0,
    ),
    followingCount: Number(
      source.followingCount ||
        source.stats?.followingCount ||
        0,
    ),
    postsCount: Number(
      source.postsCount ||
        source.stats?.postsCount ||
        0,
    ),
  };
}

async function isBlockedEitherWay(
  db,
  requesterUid,
  targetUid,
) {
  if (
    !requesterUid ||
    !targetUid ||
    requesterUid === targetUid
  )
    return false;
  const [a, b] = await Promise.all([
    db
      .ref(
        `users/${requesterUid}/blocked/${targetUid}`,
      )
      .get(),
    db
      .ref(
        `users/${targetUid}/blocked/${requesterUid}`,
      )
      .get(),
  ]);
  return a.exists() || b.exists();
}

function clean(value, max = 500) {
  return String(value || "")
    .trim()
    .slice(0, max);
}
function validateAvatarData(value) {
  const data = String(value || "").trim();
  if (!data) return "";
  if (
    !/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(
      data,
    )
  )
    throw new Error("Invalid profile photo.");
  if (data.length > 7 * 1024 * 1024)
    throw new Error(
      "Profile photo is too large.",
    );
  return data;
}
async function uploadProfileAvatar({
  uid,
  data,
}) {
  const avatarData = validateAvatarData(data);
  if (!avatarData) return "";
  const timestamp = Math.floor(Date.now() / 1000);
  const { cloudName, apiKey } =
    getCloudinaryConfig();
  const folder = "indo/profiles";
  const publicId = `profile_${uid}`;
  const signature = createCloudinarySignature(
    timestamp,
    {
      folder,
      public_id: publicId,
    },
  );
  const body = new URLSearchParams({
    file: avatarData,
    api_key: apiKey,
    timestamp: String(timestamp),
    folder,
    public_id: publicId,
    signature,
    overwrite: "true",
    invalidate: "true",
  });
  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
    { method: "POST", body },
  );
  const result = await response
    .json()
    .catch(() => ({}));
  if (!response.ok || !result.secure_url)
    throw new Error(
      result.error?.message ||
        "Could not upload profile photo.",
    );
  return String(result.secure_url);
}

export function createAccountContactRouter({
  db,
  auth,
  requireUser,
}) {
  const router = express.Router();

  router.patch(
    "/account/profile",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const name = clean(req.body?.name, 80);
      const bio = clean(req.body?.bio, 160);
      const location = clean(
        req.body?.location,
        100,
      );
      const website = clean(
        req.body?.website,
        200,
      );
      const role = clean(req.body?.role, 60);
      const interests = clean(
        req.body?.interests,
        240,
      );
      const language = clean(
        req.body?.language,
        40,
      );
      const visibility =
        req.body?.visibility === "private"
          ? "private"
          : "public";
      if (!name)
        return res
          .status(400)
          .json({
            ok: false,
            error: "User Name is required.",
          });
      try {
        const userRef = db.ref(
          `users/${user.uid}`,
        );
        const snapshot = await userRef.get();
        if (!snapshot.exists())
          return res
            .status(404)
            .json({
              ok: false,
              error: "Profile not found.",
            });
        const previous = snapshot.val() || {};
        const previousProfile =
          previous.profile || {};
        let avatarUrl = String(
          previousProfile.avatarUrl ||
            previousProfile.photoURL ||
            previous.avatarUrl ||
            previous.photoURL ||
            "",
        );
        if (req.body?.avatarData)
          avatarUrl = await uploadProfileAvatar({
            uid: user.uid,
            data: req.body.avatarData,
          });
        if (req.body?.avatarUrl)
          avatarUrl = clean(
            req.body.avatarUrl,
            1200,
          );
        const now = Date.now();
        const profile = {
          ...previousProfile,
          uid: user.uid,
          userId:
            previousProfile.userId ||
            previous.userId ||
            "",
          username:
            previousProfile.username ||
            previous.username ||
            previous.userId ||
            "",
          name,
          displayName: name,
          bio,
          location,
          website,
          role,
          interests,
          language,
          accountType: visibility,
          avatarUrl,
          photoURL: avatarUrl,
          updatedAt: now,
        };
        // Use non-overlapping Firebase paths. Updating both `profile` and `profile/updatedAt`
        // in the same multi-location update causes an ancestor/child conflict.
        await userRef.update({
          name,
          bio,
          location,
          website,
          role,
          interests,
          language,
          accountType: visibility,
          avatarUrl,
          photoURL: avatarUrl,
          profile,
          updatedAt: now,
        });
        return res.json({
          ok: true,
          profile: publicProfile(profile),
        });
      } catch (error) {
        console.error(
          "Profile update failed:",
          error,
        );
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not update profile.",
        });
      }
    },
  );

  router.patch(
    "/account/contact",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const mobile = String(
        req.body?.mobile || "",
      ).trim();
      const email = String(
        req.body?.email || user.email || "",
      )
        .trim()
        .toLowerCase();
      if (!mobile)
        return res
          .status(400)
          .json({
            ok: false,
            error: "Mobile number is required.",
          });
      if (!/^\+?[0-9 ()-]{7,20}$/.test(mobile))
        return res
          .status(400)
          .json({
            ok: false,
            error: "Invalid mobile number.",
          });
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      )
        return res
          .status(400)
          .json({
            ok: false,
            error: "Invalid email address.",
          });
      try {
        const userRef = db.ref(
          `users/${user.uid}`,
        );
        const snapshot = await userRef.get();
        if (!snapshot.exists())
          return res
            .status(404)
            .json({
              ok: false,
              error: "Profile not found.",
            });
        await userRef.update({
          mobile,
          email,
          contactUpdatedAt: Date.now(),
        });
        return res.json({
          ok: true,
          mobile,
          email,
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not save contact details.",
        });
      }
    },
  );

  router.get(
    "/account/public-profile/:uid",
    async (req, res) => {
      const viewer = await requireUser(req, res);
      if (!viewer) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const uid = String(
        req.params.uid || "",
      ).trim();
      if (!uid)
        return res
          .status(400)
          .json({
            ok: false,
            error: "User ID is required.",
          });
      try {
        const snapshot = await db
          .ref(`users/${uid}`)
          .get();
        if (!snapshot.exists())
          return res
            .status(404)
            .json({
              ok: false,
              error: "Profile not found.",
            });
        return res.json({
          ok: true,
          profile: publicProfile(
            snapshot.val() || {},
          ),
        });
      } catch (error) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              error.message ||
              "Could not load profile.",
          });
      }
    },
  );

  router.get(
    "/messages/:targetUid",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const targetUid = clean(
        req.params.targetUid,
        160,
      );
      if (!targetUid || targetUid === user.uid)
        return res
          .status(400)
          .json({
            ok: false,
            error: "Valid recipient is required.",
          });
      try {
        const targetSnapshot = await db
          .ref(`users/${targetUid}`)
          .get();
        if (!targetSnapshot.exists())
          return res
            .status(404)
            .json({
              ok: false,
              error:
                "Recipient profile not found.",
            });
        if (
          await isBlockedEitherWay(
            db,
            user.uid,
            targetUid,
          )
        )
          return res.status(403).json({
            ok: false,
            error:
              "Messaging is unavailable because one account has blocked the other.",
          });
        const key = [user.uid, targetUid]
          .sort()
          .join("_");
        const snapshot = await db
          .ref(`messages/${key}`)
          .limitToLast(100)
          .get();
        const messages = Object.values(
          snapshot.val() || {},
        ).sort(
          (a, b) =>
            Number(a.createdAt || 0) -
            Number(b.createdAt || 0),
        );
        return res.json({
          ok: true,
          messages,
          recipient: publicProfile(
            targetSnapshot.val() || {},
          ),
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not load messages.",
        });
      }
    },
  );

  router.post(
    "/messages/:targetUid",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const targetUid = clean(
        req.params.targetUid,
        160,
      );
      const text = clean(req.body?.text, 1000);
      if (!targetUid || targetUid === user.uid)
        return res
          .status(400)
          .json({
            ok: false,
            error: "Valid recipient is required.",
          });
      if (!text)
        return res
          .status(400)
          .json({
            ok: false,
            error: "Message cannot be empty.",
          });
      try {
        const [senderSnapshot, targetSnapshot] =
          await Promise.all([
            db.ref(`users/${user.uid}`).get(),
            db.ref(`users/${targetUid}`).get(),
          ]);
        if (!targetSnapshot.exists())
          return res
            .status(404)
            .json({
              ok: false,
              error:
                "Recipient profile not found.",
            });
        if (
          await isBlockedEitherWay(
            db,
            user.uid,
            targetUid,
          )
        )
          return res.status(403).json({
            ok: false,
            error:
              "Messaging is unavailable because one account has blocked the other.",
          });
        const sender = senderSnapshot.val() || {};
        const key = [user.uid, targetUid]
          .sort()
          .join("_");
        const ref = db
          .ref(`messages/${key}`)
          .push();
        const message = {
          id: ref.key,
          senderUid: user.uid,
          recipientUid: targetUid,
          senderUserId:
            sender.username ||
            `@${user.uid.slice(0, 8)}`,
          text,
          readByRecipient: false,
          createdAt: Date.now(),
        };
        await ref.set(message);
        const senderAvatar = String(
          sender.profile?.avatarUrl ||
            sender.profile?.photoURL ||
            sender.avatarUrl ||
            sender.photoURL ||
            "",
        );
        const recipient =
          targetSnapshot.val() || {};
        const recipientAvatar = String(
          recipient.profile?.avatarUrl ||
            recipient.profile?.photoURL ||
            recipient.avatarUrl ||
            recipient.photoURL ||
            "",
        );
        await db
          .ref(`messageInbox/${targetUid}/${key}`)
          .set({
            conversationId: key,
            otherUid: user.uid,
            otherUserId:
              sender.username ||
              `@${user.uid.slice(0, 8)}`,
            otherName: sender.name || "Indo User",
            otherAvatarUrl: senderAvatar,
            lastMessage: text,
            updatedAt: message.createdAt,
            unread: true,
          });
        await db
          .ref(`messageInbox/${user.uid}/${key}`)
          .set({
            conversationId: key,
            otherUid: targetUid,
            otherUserId:
              recipient.username ||
              `@${targetUid.slice(0, 8)}`,
            otherName:
              recipient.name || "Indo User",
            otherAvatarUrl: recipientAvatar,
            lastMessage: text,
            updatedAt: message.createdAt,
            unread: false,
          });
        return res
          .status(201)
          .json({ ok: true, message });
      } catch (error) {
        return res
          .status(500)
          .json({
            ok: false,
            error:
              error.message ||
              "Could not send message.",
          });
      }
    },
  );

  router.post(
    "/messages/:targetUid/read",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db)
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      const targetUid = clean(
        req.params.targetUid,
        160,
      );
      if (!targetUid || targetUid === user.uid)
        return res
          .status(400)
          .json({
            ok: false,
            error: "Valid recipient is required.",
          });
      try {
        const key = [user.uid, targetUid]
          .sort()
          .join("_");
        const snapshot = await db
          .ref(`messages/${key}`)
          .limitToLast(100)
          .get();
        const messages = snapshot.val() || {};
        const updates = {};
        for (const [
          id,
          message,
        ] of Object.entries(messages))
          if (
            message?.recipientUid === user.uid &&
            !message.readByRecipient
          )
            updates[
              `messages/${key}/${id}/readByRecipient`
            ] = true;
        if (Object.keys(updates).length)
          await db.ref().update(updates);
        await db
          .ref(
            `messageInbox/${user.uid}/${key}/unread`,
          )
          .set(false);
        return res.json({ ok: true });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not mark messages read.",
        });
      }
    },
  );

  router.get("/messages", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res.status(503).json({
        ok: false,
        error:
          "Firebase Admin is not configured on the backend.",
      });
    try {
      const snapshot = await db
        .ref(`messageInbox/${user.uid}`)
        .get();
      const conversations = Object.values(
        snapshot.val() || {},
      ).sort(
        (a, b) =>
          Number(b.updatedAt || 0) -
          Number(a.updatedAt || 0),
      );
      return res.json({
        ok: true,
        conversations,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Could not load conversations.",
      });
    }
  });

  return router;
}
