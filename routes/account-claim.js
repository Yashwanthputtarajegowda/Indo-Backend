import express from "express";
import {
  createCloudinarySignature,
  getCloudinaryConfig,
} from "../services/cloudinary-signature.js";
import { syncCanonicalUser } from "../services/user-canonical.js";

function normalizeUserId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

function validUserId(value) {
  return /^[a-z0-9._-]{1,50}$/.test(value);
}

function userIdKey(value) {
  return String(value || "")
    .replace(/\./g, "%2E")
    .replace(/#/g, "%23")
    .replace(/\$/g, "%24")
    .replace(/\//g, "%2F")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D");
}

async function legacyUserIdTaken(db, userId, uid) {
  const usersSnapshot = await db.ref("users").get();
  const users = usersSnapshot.val() || {};
  return Object.entries(users).some(([otherUid, other]) => {
    if (String(otherUid) === uid) return false;
    const existing = normalizeUserId(
      other?.profile?.userId ||
        other?.profile?.username ||
        other?.userId ||
        other?.username ||
        "",
    );
    return existing === userId;
  });
}

function clean(value, max = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

async function findUidByUserId(db, identifier) {
  const cleanId = normalizeUserId(identifier);
  if (!cleanId) return "";
  const direct = await db.ref(`usernames/${userIdKey(cleanId)}`).get();
  if (direct.exists() && direct.val()?.uid) return String(direct.val().uid);
  const users = (await db.ref("users").get()).val() || {};
  const match = Object.entries(users).find(([uid, value]) => {
    const profile = value?.profile || {};
    const current = normalizeUserId(
      profile.userId || profile.username || value?.userId || value?.username,
    );
    return current === cleanId || String(uid) === cleanId;
  });
  return match ? String(match[0]) : "";
}

function shapeProfile(profile = {}, stats = {}) {
  return {
    ...profile,
    uid: String(profile.uid || ""),
    userId: normalizeUserId(profile.userId || profile.username),
    username:
      profile.username ||
      (profile.userId ? `@${normalizeUserId(profile.userId)}` : ""),
    name: String(profile.name || profile.displayName || ""),
    displayName: String(profile.displayName || profile.name || ""),
    bio: String(profile.bio || ""),
    location: String(profile.location || ""),
    website: String(profile.website || ""),
    role: String(profile.role || ""),
    interests: String(profile.interests || ""),
    language: String(profile.language || ""),
    visibility: profile.visibility === "private" ? "private" : "public",
    avatarUrl: String(profile.avatarUrl || profile.photoURL || ""),
    photoURL: String(profile.photoURL || profile.avatarUrl || ""),
    stats: {
      videosCount: Number(stats.videosCount || 0),
      postsCount: Number(stats.postsCount || 0),
      followersCount: Number(stats.followersCount || 0),
      followingCount: Number(stats.followingCount || 0),
      likesCount: Number(stats.likesCount || 0),
    },
  };
}

export function createAccountClaimRouter({ db, requireUser }) {
  const router = express.Router();

  router.post("/account/claim-user-id", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res
        .status(503)
        .json({ ok: false, error: "Firebase database is unavailable." });

    const uid = String(user.uid || "").trim();
    const userId = normalizeUserId(req.body?.userId);
    const name = String(req.body?.name || "")
      .trim()
      .slice(0, 120);
    const accountType =
      String(req.body?.accountType || "public") === "private"
        ? "private"
        : "public";

    if (!uid)
      return res.status(400).json({ ok: false, error: "User is required." });
    if (!validUserId(userId))
      return res.status(400).json({ ok: false, error: "Invalid User ID." });
    if (!name)
      return res
        .status(400)
        .json({ ok: false, error: "User Name is required." });

    const key = userIdKey(userId);
    const username = `@${userId}`;

    try {
      if (await legacyUserIdTaken(db, userId, uid)) {
        return res
          .status(409)
          .json({ ok: false, error: `${username} is already taken.` });
      }

      const claimRef = db.ref(`usernames/${key}`);
      const claimResult = await claimRef.transaction((current) => {
        if (current && String(current.uid || "") !== uid) return;
        return { uid, username, updatedAt: Date.now() };
      });

      if (!claimResult.committed) {
        return res
          .status(409)
          .json({ ok: false, error: `${username} is already taken.` });
      }

      const claim = claimResult.snapshot.val() || {};
      if (String(claim.uid || "") !== uid) {
        return res
          .status(409)
          .json({ ok: false, error: `${username} is already taken.` });
      }

      const now = Date.now();
      const current = (await db.ref(`users/${uid}`).get()).val() || {};
      const previousProfile = current.profile || {};
      const profile = {
        ...previousProfile,
        uid,
        userId,
        username,
        name,
        displayName: name,
        bio: String(previousProfile.bio || current.bio || "").slice(0, 160),
        accountType,
        isVerified: Boolean(previousProfile.isVerified || current.isVerified),
        createdAt: previousProfile.createdAt || current.createdAt || now,
        updatedAt: now,
      };
      const profilePrivate = {
        ...(current.profilePrivate || {}),
        email:
          user.email || current.profilePrivate?.email || current.email || "",
      };

      await db.ref().update({
        [`users/${uid}/profile`]: profile,
        [`users/${uid}/profilePrivate`]: profilePrivate,
        [`users/${uid}/userId`]: username,
        [`users/${uid}/username`]: username,
        [`users/${uid}/name`]: name,
        [`users/${uid}/accountType`]: accountType,
        [`users/${uid}/updatedAt`]: now,
        [`usernames/${key}`]: { uid, username, updatedAt: now },
      });

      const verify = (await db.ref(`users/${uid}/profile`).get()).val() || {};
      if (normalizeUserId(verify.userId || verify.username) !== userId) {
        await claimRef.transaction((current) =>
          String(current?.uid || "") === uid ? null : current,
        );
        return res
          .status(500)
          .json({
            ok: false,
            error: "Could not verify the Indo profile write.",
          });
      }

      return res.status(201).json({ ok: true, profile });
    } catch (error) {
      console.error("Canonical account claim failed:", error);
      return res.status(500).json({
        ok: false,
        error: "Could not create the Indo profile.",
        detail: String(error?.message || error || "Unknown error"),
      });
    }
  });

  router.post("/account/check-user-id", async (req, res) => {
    if (!db)
      return res
        .status(503)
        .json({ ok: false, error: "Firebase database is unavailable." });
    const userId = normalizeUserId(req.body?.userId);
    if (!validUserId(userId))
      return res.status(400).json({ ok: false, error: "Invalid User ID." });
    try {
      const indexed = await db.ref(`usernames/${userIdKey(userId)}`).get();
      if (indexed.exists())
        return res.json({ ok: true, available: false, userId });
      const taken = await legacyUserIdTaken(db, userId, "");
      return res.json({ ok: true, available: !taken, userId });
    } catch (error) {
      console.error("User ID availability check failed:", error);
      return res
        .status(500)
        .json({
          ok: false,
          error: "Could not check User ID. Please try again.",
        });
    }
  });

  router.get("/account/search-users", async (req, res) => {
    if (!db)
      return res
        .status(503)
        .json({ ok: false, error: "Firebase database is unavailable." });
    const query = normalizeUserId(req.query?.q);
    if (!query || !validUserId(query)) return res.json({ ok: true, users: [] });
    try {
      const snapshot = await db.ref("users").get();
      const users = Object.entries(snapshot.val() || {})
        .map(([uid, value]) => {
          const profile = value?.profile || {};
          const userId = normalizeUserId(
            profile.userId ||
              profile.username ||
              value?.userId ||
              value?.username,
          );
          if (!userId || !userId.startsWith(query)) return null;
          return {
            uid,
            userId: `@${userId}`,
            name: String(profile.name || value?.name || "Indo User"),
            avatarUrl: String(
              profile.avatarUrl ||
                profile.photoURL ||
                value?.avatarUrl ||
                value?.photoURL ||
                "",
            ),
            isVerified: Boolean(profile.isVerified || value?.isVerified),
            postsCount: Number(
              value?.stats?.postsCount ?? profile.postsCount ?? 0,
            ),
            followersCount: Number(
              value?.stats?.followersCount ?? profile.followersCount ?? 0,
            ),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.userId.localeCompare(b.userId))
        .slice(0, 20);
      return res.json({ ok: true, users });
    } catch (error) {
      console.error("User search failed:", error);
      return res
        .status(500)
        .json({ ok: false, error: "Could not search users." });
    }
  });

  router.get("/account/me", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res
        .status(503)
        .json({ ok: false, error: "Firebase database is unavailable." });
    try {
      const canonical = await syncCanonicalUser({
        db,
        uid: user.uid,
        includeContent: true,
      });
      return res.json({
        ok: true,
        profile: shapeProfile(canonical.profile, canonical.stats),
        stats: canonical.stats,
        social: canonical.social,
      });
    } catch (error) {
      console.error("Load own profile failed:", error);
      return res
        .status(500)
        .json({ ok: false, error: "Could not load profile." });
    }
  });

  router.get("/account/profile/:identifier", async (req, res) => {
    const viewer = await requireUser(req, res);
    if (!viewer) return;
    if (!db)
      return res
        .status(503)
        .json({ ok: false, error: "Firebase database is unavailable." });
    try {
      const uid = await findUidByUserId(db, req.params.identifier);
      if (!uid)
        return res.status(404).json({ ok: false, error: "Profile not found." });
      const canonical = await syncCanonicalUser({
        db,
        uid,
        includeContent: true,
      });
      return res.json({
        ok: true,
        profile: shapeProfile(canonical.profile, canonical.stats),
        stats: canonical.stats,
        social: canonical.social,
      });
    } catch (error) {
      console.error("Load profile failed:", error);
      return res
        .status(500)
        .json({ ok: false, error: "Could not load profile." });
    }
  });

  router.patch("/account/profile", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res
        .status(503)
        .json({ ok: false, error: "Firebase database is unavailable." });

    const uid = String(user.uid || "").trim();
    const current = (await db.ref(`users/${uid}`).get()).val() || {};
    const currentProfile = current.profile || {};
    const name = clean(req.body?.name, 80);
    if (!name)
      return res.status(400).json({ ok: false, error: "Name is required." });

    const nextProfile = {
      ...currentProfile,
      uid,
      userId: normalizeUserId(
        currentProfile.userId || current.userId || current.username,
      ),
      username:
        currentProfile.username ||
        current.username ||
        (currentProfile.userId
          ? `@${normalizeUserId(currentProfile.userId)}`
          : ""),
      name,
      displayName: name,
      bio: clean(req.body?.bio, 160),
      location: clean(req.body?.location, 100),
      website: clean(req.body?.website, 200),
      role: clean(req.body?.role, 60),
      interests: clean(req.body?.interests, 240),
      language: clean(req.body?.language, 40),
      visibility:
        String(req.body?.visibility || "public") === "private"
          ? "private"
          : "public",
      avatarUrl: clean(
        req.body?.avatarUrl ||
          currentProfile.avatarUrl ||
          currentProfile.photoURL,
        1200,
      ),
      photoURL: clean(
        req.body?.photoURL ||
          req.body?.avatarUrl ||
          currentProfile.photoURL ||
          currentProfile.avatarUrl,
        1200,
      ),
      updatedAt: Date.now(),
    };

    try {
      await db.ref().update({
        [`users/${uid}/profile`]: nextProfile,
        [`users/${uid}/name`]: name,
        [`users/${uid}/updatedAt`]: Date.now(),
      });
      const canonical = await syncCanonicalUser({
        db,
        uid,
        includeContent: true,
      });
      return res.json({
        ok: true,
        profile: shapeProfile(canonical.profile, canonical.stats),
        stats: canonical.stats,
        social: canonical.social,
      });
    } catch (error) {
      console.error("Save profile failed:", error);
      return res
        .status(500)
        .json({ ok: false, error: "Could not save profile." });
    }
  });

  router.post("/account/profile/avatar-signature", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const folder = "indo/profiles";
      return res.json({
        ok: true,
        ...getCloudinaryConfig(),
        timestamp,
        folder,
        resourceType: "image",
        signature: createCloudinarySignature(timestamp, { folder }),
      });
    } catch (error) {
      console.error("Profile avatar signature failed:", error);
      return res
        .status(503)
        .json({
          ok: false,
          error: "Profile photo upload is temporarily unavailable.",
        });
    }
  });

  return router;
}
