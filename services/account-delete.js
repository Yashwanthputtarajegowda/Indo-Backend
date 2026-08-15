export async function deleteAccountData({
  db,
  auth,
  uid,
}) {
  if (!db || !auth) {
    throw new Error(
      "Firebase Admin is not configured on the backend.",
    );
  }

  const userRef = db.ref(`users/${uid}`);
  const snapshot = await userRef.get();
  const profile = snapshot.exists()
    ? snapshot.val() || {}
    : {};
  const usernameKey = profile.usernameKey;

  if (usernameKey) {
    const usernameRef = db.ref(
      `usernames/${usernameKey}`,
    );
    const usernameSnapshot =
      await usernameRef.get();
    if (
      usernameSnapshot.exists() &&
      usernameSnapshot.val()?.uid === uid
    ) {
      await usernameRef.remove();
    }
  }

  await userRef.remove();

  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      throw error;
    }
  }

  return { deleted: true, uid };
}
