import express from "express";

function normalizeUserId(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/^@+/, "");
  return raw;
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

export function createAccountClaimRouter({ db, requireUser }) {
  const router = express.Router();

  router.post("/account/claim-user-id", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Firebase database is unavailable." });

    const uid = String(user.uid || "").trim();
    const userId = normalizeUserId(req.body?.userId);
    const name = String(req.body?.name || "").trim().slice(0, 120);
    const accountType = String(req.body?.accountType || "public") === "private" ? "private" : "public";

    if (!uid) return res.status(400).json({ ok: false, error: "User is required." });
    if (!validUserId(userId)) return res.status(400).json({ ok: false, error: "Invalid User ID." });
    if (!name) return res.status(400).json({ ok: false, error: "User Name is required." });

    const key = userIdKey(userId);
    const username = `@${userId}`;

    try {
      // The usernames index is the authoritative uniqueness lock. A transaction
      // prevents two accounts from claiming the same ID at the same time.
      const claimRef = db.ref(`usernames/${key}`);
      const claimResult = await claimRef.transaction((current) => {
        if (current && String(current.uid || "") !== uid) return;
        return { uid, username, updatedAt: Date.now() };
      });

      if (!claimResult.committed) {
        return res.status(409).json({ ok: false, error: `${username} is already taken.` });
      }

      const claim = claimResult.snapshot.val() || {};
      if (String(claim.uid || "") !== uid) {
        return res.status(409).json({ ok: false, error: `${username} is already taken.` });
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
        email: user.email || current.profilePrivate?.email || current.email || "",
      };

      const updates = {
        [`users/${uid}/profile`]: profile,
        [`users/${uid}/profilePrivate`]: profilePrivate,
        [`users/${uid}/userId`]: username,
        [`users/${uid}/username`]: username,
        [`users/${uid}/name`]: name,
        [`users/${uid}/accountType`]: accountType,
        [`users/${uid}/updatedAt`]: now,
        [`usernames/${key}`]: { uid, username, updatedAt: now },
      };

      await db.ref().update(updates);

      const verify = (await db.ref(`users/${uid}/profile`).get()).val() || {};
      if (normalizeUserId(verify.userId || verify.username) !== userId) {
        await claimRef.transaction((current) => String(current?.uid || "") === uid ? null : current);
        return res.status(500).json({ ok: false, error: "Could not verify the Indo profile write." });
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
    if (!db) return res.status(503).json({ ok: false, error: "Firebase database is unavailable." });
    const userId = normalizeUserId(req.body?.userId);
    if (!validUserId(userId)) return res.status(400).json({ ok: false, error: "Invalid User ID." });
    try {
      const claim = await db.ref(`usernames/${userIdKey(userId)}`).get();
      return res.json({ ok: true, available: !claim.exists(), userId });
    } catch (error) {
      console.error("User ID availability check failed:", error);
      return res.status(500).json({ ok: false, error: "Could not check User ID. Please try again." });
    }
  });

  return router;
}
