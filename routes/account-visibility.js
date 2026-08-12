import express from "express";

export function createAccountVisibilityRouter({ db, requireUser }) {
  const router = express.Router();

  router.patch("/account/visibility", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db)
      return res
        .status(503)
        .json({
          ok: false,
          error: "Firebase Admin is not configured on the backend.",
        });

    const accountType =
      req.body?.accountType === "private" ? "private" : "public";

    try {
      const userRef = db.ref(`users/${user.uid}`);
      const snapshot = await userRef.get();
      if (!snapshot.exists())
        return res.status(404).json({ ok: false, error: "Profile not found." });

      await userRef.update({ accountType, visibilityUpdatedAt: Date.now() });
      return res.json({ ok: true, accountType });
    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error: error.message || "Could not update account visibility.",
        });
    }
  });

  return router;
}
