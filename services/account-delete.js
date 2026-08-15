export async function deleteAccountData({
  db,
  auth,
  uid,
}) {
  if (!db || !auth) {
    throw new Error("Firebase Admin is not configured on the backend.");
  }
  if (!uid || typeof uid !== "string" || uid.length > 128) {
    throw new Error("Invalid account identifier.");
  }

  // Delete application data first. Authentication deletion is performed only
  // for the already-authenticated UID supplied by the backend auth layer.
  const userRef = db.ref(`users/${uid}`);
  const snapshot = await userRef.get();
  const profile = snapshot.exists() ? snapshot.val() || {} : {};
  const usernameKey = profile.usernameKey;

  if (usernameKey) {
    const usernameRef = db.ref(`usernames/${usernameKey}`);
    const usernameSnapshot = await usernameRef.get();
    if (
      usernameSnapshot.exists() &&
      usernameSnapshot.val()?.uid === uid
    ) {
      await usernameRef.remove();
    }
  }

  await userRef.remove();

  try {
    await auth.revokeRefreshTokens(uid);
    await auth.deleteUser(uid);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") throw error;
  }

  return { deleted: true, uid };
}
