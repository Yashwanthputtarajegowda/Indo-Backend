const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;

export async function cleanupInactiveAccounts({ db, auth, now = Date.now() }) {
  if (!db || !auth) {
    return { checked: 0, deleted: 0, skipped: true };
  }

  const snapshot = await db.ref("users").get();

  if (!snapshot.exists()) {
    return { checked: 0, deleted: 0, skipped: false };
  }

  const users = snapshot.val() || {};
  let checked = 0;
  let deleted = 0;

  for (const [uid, profile] of Object.entries(users)) {
    checked += 1;

    const lastActiveAt = Number(
      profile?.lastActiveAt || profile?.createdAt || 0,
    );

    if (!lastActiveAt || now - lastActiveAt < SIX_MONTHS_MS) {
      continue;
    }

    const usernameKey = profile?.usernameKey;

    if (usernameKey) {
      const usernameSnapshot = await db.ref(`usernames/${usernameKey}`).get();
      if (usernameSnapshot.exists() && usernameSnapshot.val()?.uid === uid) {
        await db.ref(`usernames/${usernameKey}`).remove();
      }
    }

    // Remove account-owned data before deleting the Firebase Auth user.
    await db.ref(`users/${uid}`).remove();

    try {
      await auth.deleteUser(uid);
    } catch (error) {
      if (error?.code !== "auth/user-not-found") {
        throw error;
      }
    }

    deleted += 1;
  }

  return { checked, deleted, skipped: false };
}

export { SIX_MONTHS_MS };
