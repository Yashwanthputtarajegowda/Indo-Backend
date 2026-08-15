import express from "express";

const cleanText = (value, max = 500) =>
  String(value ?? "")
    .trim()
    .slice(0, max);

async function saveCanonicalProfile({
  req,
  res,
  db,
  requireUser,
}) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (!db) {
    res.status(503).json({
      ok: false,
      error:
        "Firebase Admin is not configured on the backend.",
    });
    return null;
  }

  const name = cleanText(req.body?.name, 80);
  if (!name) {
    res
      .status(400)
      .json({
        ok: false,
        error: "User Name is required.",
      });
    return null;
  }

  try {
    const userRef = db.ref(`users/${user.uid}`);
    const snapshot = await userRef.get();
    if (!snapshot.exists()) {
      res
        .status(404)
        .json({
          ok: false,
          error: "Profile not found.",
        });
      return null;
    }

    const previous = snapshot.val() || {};
    const previousProfile =
      previous.profile &&
      typeof previous.profile === "object"
        ? previous.profile
        : {};
    const now = Date.now();

    const profile = {
      ...previousProfile,
      uid: String(user.uid),
      name,
      displayName: name,
      bio: cleanText(
        req.body?.bio ??
          previousProfile.bio ??
          previous.bio,
        160,
      ),
      location: cleanText(
        req.body?.location ??
          previousProfile.location ??
          previous.location,
        100,
      ),
      website: cleanText(
        req.body?.website ??
          previousProfile.website ??
          previous.website,
        200,
      ),
      role: cleanText(
        req.body?.role ??
          previousProfile.role ??
          previous.role ??
          "Content Creator",
        60,
      ),
      interests: cleanText(
        req.body?.interests ??
          previousProfile.interests ??
          previous.interests,
        240,
      ),
      language: cleanText(
        req.body?.language ??
          previousProfile.language ??
          previous.language ??
          "English",
        40,
      ),
      accountType:
        req.body?.visibility === "private"
          ? "private"
          : req.body?.visibility === "public"
            ? "public"
            : previousProfile.accountType ||
              previous.accountType ||
              "public",
      updatedAt: now,
    };

    if (req.body?.avatarUrl !== undefined) {
      profile.avatarUrl = cleanText(
        req.body.avatarUrl,
        1000,
      );
    }
    if (req.body?.photoURL !== undefined) {
      profile.photoURL = cleanText(
        req.body.photoURL,
        1000,
      );
    }

    const updates = {
      name,
      bio: profile.bio,
      location: profile.location,
      website: profile.website,
      role: profile.role,
      interests: profile.interests,
      language: profile.language,
      accountType: profile.accountType,
      profile,
      updatedAt: now,
    };

    if (profile.avatarUrl !== undefined)
      updates.avatarUrl = profile.avatarUrl;
    if (profile.photoURL !== undefined)
      updates.photoURL = profile.photoURL;

    await userRef.update(updates);
    return res.json({ ok: true, profile });
  } catch (error) {
    console.error(
      "Canonical profile update failed:",
      error,
    );
    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Could not update profile.",
    });
  }
}

export function createAccountVisibilityRouter({
  db,
  requireUser,
}) {
  const router = express.Router();

  router.patch(
    "/account/visibility",
    async (req, res) => {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!db) {
        return res.status(503).json({
          ok: false,
          error:
            "Firebase Admin is not configured on the backend.",
        });
      }
      const accountType =
        req.body?.accountType === "private"
          ? "private"
          : "public";
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
          accountType,
          visibilityUpdatedAt: Date.now(),
        });
        return res.json({
          ok: true,
          accountType,
        });
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            error.message ||
            "Could not update account visibility.",
        });
      }
    },
  );

  // Canonical profile endpoint used by the current Edit Profile screen.
  router.patch(
    "/account/profile-canonical-save",
    async (req, res) => {
      await saveCanonicalProfile({
        req,
        res,
        db,
        requireUser,
      });
    },
  );

  // Keep the public endpoint on the same canonical writer for any current screen that uses it.
  router.patch(
    "/account/profile",
    async (req, res) => {
      await saveCanonicalProfile({
        req,
        res,
        db,
        requireUser,
      });
    },
  );

  return router;
}
