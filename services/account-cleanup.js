import { destroyCloudinaryVideo } from "./cloudinary-signature.js";

const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;

async function cleanupExpiredStories({
  db,
  now = Date.now(),
}) {
  if (!db) return { checked: 0, deleted: 0 };
  const snapshot = await db.ref("stories").get();
  if (!snapshot.exists())
    return { checked: 0, deleted: 0 };

  const stories = snapshot.val() || {};
  let checked = 0;
  let deleted = 0;

  for (const [storyId, story] of Object.entries(
    stories,
  )) {
    checked += 1;
    const expiresAt = Number(
      story?.expiresAt || 0,
    );
    if (!expiresAt || expiresAt > now) continue;

    if (story?.publicId) {
      try {
        await destroyCloudinaryVideo(
          story.publicId,
        );
      } catch (error) {
        console.warn(
          "Expired Cloudinary story delete failed:",
          error?.message || error,
        );
      }
    }

    await db.ref(`stories/${storyId}`).remove();
    deleted += 1;
  }

  return { checked, deleted };
}

export async function cleanupInactiveAccounts({
  db,
  auth,
  now = Date.now(),
}) {
  if (!db || !auth) {
    return {
      checked: 0,
      deleted: 0,
      storiesChecked: 0,
      storiesDeleted: 0,
      skipped: true,
    };
  }

  const storyCleanup =
    await cleanupExpiredStories({ db, now });
  const snapshot = await db.ref("users").get();

  if (!snapshot.exists()) {
    return {
      checked: 0,
      deleted: 0,
      ...storyCleanup,
      skipped: false,
    };
  }

  const users = snapshot.val() || {};
  let checked = 0;
  let deleted = 0;

  for (const [uid, profile] of Object.entries(
    users,
  )) {
    checked += 1;

    const lastActiveAt = Number(
      profile?.lastActiveAt ||
        profile?.createdAt ||
        0,
    );

    if (
      !lastActiveAt ||
      now - lastActiveAt < SIX_MONTHS_MS
    ) {
      continue;
    }

    const usernameKey = profile?.usernameKey;

    if (usernameKey) {
      const usernameSnapshot = await db
        .ref(`usernames/${usernameKey}`)
        .get();
      if (
        usernameSnapshot.exists() &&
        usernameSnapshot.val()?.uid === uid
      ) {
        await db
          .ref(`usernames/${usernameKey}`)
          .remove();
      }
    }

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

  return {
    checked,
    deleted,
    ...storyCleanup,
    skipped: false,
  };
}

export { SIX_MONTHS_MS, cleanupExpiredStories };
