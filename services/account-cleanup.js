import { canonicalUserRoot } from "./user-canonical.js";
import { deleteCanonicalVideo } from "./canonical-content.js";
import { getDriveFile } from "./google-drive-storage.js";

const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;

async function cleanupExpiredStories({ db, now = Date.now() }) {
  if (!db) return { checked: 0, deleted: 0 };
  const snapshot = await db.ref("stories").get();
  if (!snapshot.exists()) return { checked: 0, deleted: 0 };
  const stories = snapshot.val() || {};
  let checked = 0;
  let deleted = 0;
  for (const [storyId, story] of Object.entries(stories)) {
    checked += 1;
    if (Number(story?.expiresAt || 0) > now || !story?.expiresAt) continue;
    await db.ref(`stories/${storyId}`).remove();
    deleted += 1;
  }
  return { checked, deleted };
}

async function cleanupMissingGoogleDriveVideos({ db }) {
  if (!db) return { checked: 0, deleted: 0 };
  const snapshot = await db.ref("videos").get();
  if (!snapshot.exists()) return { checked: 0, deleted: 0 };
  const videos = snapshot.val() || {};
  let checked = 0;
  let deleted = 0;
  for (const [videoId, video] of Object.entries(videos)) {
    if (String(video?.storage?.provider || "").toLowerCase() !== "google-drive") continue;
    const ownerUid = String(video?.ownerUid || "").trim();
    const fileId = String(video?.googleDrive?.fileId || "").trim();
    if (!ownerUid || !fileId) continue;
    checked += 1;
    try {
      await getDriveFile(fileId);
    } catch (error) {
      if (error?.code !== "DRIVE_FILE_NOT_FOUND" && Number(error?.status) !== 404) continue;
      try {
        await deleteCanonicalVideo({ db, uid: ownerUid, videoId, googleDriveFileId: fileId });
        await db.ref(`${canonicalUserRoot(ownerUid)}/stats/postsCount`).transaction((current) => Math.max(0, (Number(current) || 0) - 1));
        await db.ref(`${canonicalUserRoot(ownerUid)}/stats/videosCount`).transaction((current) => Math.max(0, (Number(current) || 0) - 1));
        deleted += 1;
      } catch (cleanupError) {
        console.warn(`Could not clean missing Google Drive video ${videoId}:`, cleanupError?.message || cleanupError);
      }
    }
  }
  return { checked, deleted };
}

export async function cleanupInactiveAccounts({ db, auth, now = Date.now() }) {
  if (!db || !auth) return { checked: 0, deleted: 0, storiesChecked: 0, storiesDeleted: 0, driveVideosChecked: 0, driveVideosDeleted: 0, skipped: true };
  const storyCleanup = await cleanupExpiredStories({ db, now });
  const driveCleanup = await cleanupMissingGoogleDriveVideos({ db });
  const snapshot = await db.ref("users").get();
  if (!snapshot.exists()) return { checked: 0, deleted: 0, ...storyCleanup, driveVideosChecked: driveCleanup.checked, driveVideosDeleted: driveCleanup.deleted, skipped: false };
  const users = snapshot.val() || {};
  let checked = 0;
  let deleted = 0;
  for (const [uid, profile] of Object.entries(users)) {
    checked += 1;
    const lastActiveAt = Number(profile?.lastActiveAt || profile?.createdAt || 0);
    if (!lastActiveAt || now - lastActiveAt < SIX_MONTHS_MS) continue;
    const usernameKey = profile?.usernameKey;
    if (usernameKey) {
      const usernameSnapshot = await db.ref(`usernames/${usernameKey}`).get();
      if (usernameSnapshot.exists() && usernameSnapshot.val()?.uid === uid) await db.ref(`usernames/${usernameKey}`).remove();
    }
    await db.ref(`users/${uid}`).remove();
    try { await auth.deleteUser(uid); } catch (error) { if (error?.code !== "auth/user-not-found") throw error; }
    deleted += 1;
  }
  return { checked, deleted, ...storyCleanup, driveVideosChecked: driveCleanup.checked, driveVideosDeleted: driveCleanup.deleted, skipped: false };
}

export { SIX_MONTHS_MS, cleanupExpiredStories, cleanupMissingGoogleDriveVideos };
