import { canonicalUserRoot } from "./user-canonical.js";
import { deleteDriveFile } from "./google-drive-storage.js";

function cleanForRealtime(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(cleanForRealtime).filter((item) => item !== undefined);
  if (typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const cleaned = cleanForRealtime(item);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}

export function canonicalVideoPath(uid, videoId) {
  return `${canonicalUserRoot(uid)}/content/videos/${videoId}`;
}

export function canonicalStoryPath(uid, storyId) {
  return `${canonicalUserRoot(uid)}/content/stories/${storyId}`;
}

export async function saveCanonicalVideo({ db, uid, video }) {
  if (!db || !uid || !video?.id) return;
  const root = canonicalUserRoot(uid);
  const safeVideo = cleanForRealtime({
    ...video,
    tags: Array.isArray(video.tags) ? video.tags : [],
  });
  await db.ref().update({
    [`${root}/content/posts/${video.id}`]: safeVideo,
    [`${root}/content/videos/${video.id}`]: safeVideo,
  });
}

export async function updateCanonicalVideoViews({ db, uid, videoId, views }) {
  if (!db || !uid || !videoId) return;
  await db.ref(`${canonicalVideoPath(uid, videoId)}/views`).set(Number(views) || 0);
  await db.ref(`${canonicalUserRoot(uid)}/stats/viewsCount`).transaction(
    (current) => Math.max(0, Number(current) || 0) + 1,
  );
}

async function deleteDriveWithRetry(fileId) {
  const id = String(fileId || "").trim();
  if (!id) {
    return { attempted: false, deleted: false, alreadyMissing: false, error: "" };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await deleteDriveFile(id);
      return {
        attempted: true,
        deleted: Boolean(result?.deleted),
        alreadyMissing: Boolean(result?.alreadyMissing || result?.missing),
        error: "",
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  return {
    attempted: true,
    deleted: false,
    alreadyMissing: false,
    error: String(lastError?.message || lastError || "Google Drive delete failed.").slice(0, 300),
  };
}

async function readVideoDriveFileId(db, videoId) {
  const snapshot = await db.ref(`videos/${videoId}`).get();
  if (!snapshot.exists()) return "";
  const video = snapshot.val() || {};
  return String(video?.googleDrive?.fileId || "").trim();
}

export async function deleteCanonicalVideo({ db, uid, videoId, googleDriveFileId = "" }) {
  if (!db || !uid) return { deleted: false, missingInput: true };

  const cleanVideoId = String(videoId || "").trim();
  if (!cleanVideoId) return { deleted: false, missingInput: true };

  let driveFileId = String(googleDriveFileId || "").trim();
  if (!driveFileId) driveFileId = await readVideoDriveFileId(db, cleanVideoId);

  /*
   * Firebase is the application's source of truth for the feed.
   * Remove every application-side copy first. This makes deletion durable
   * even when Google Drive is temporarily unavailable.
   */
  await db.ref().update({
    [`videos/${cleanVideoId}`]: null,
    [`${canonicalUserRoot(uid)}/content/posts/${cleanVideoId}`]: null,
    [`${canonicalUserRoot(uid)}/content/videos/${cleanVideoId}`]: null,
    [`${canonicalUserRoot(uid)}/engagement/videos/${cleanVideoId}`]: null,
    [`videoLikes/${cleanVideoId}`]: null,
    [`videoComments/${cleanVideoId}`]: null,
    [`videoSaves/${cleanVideoId}`]: null,
  });

  const drive = await deleteDriveWithRetry(driveFileId);

  return {
    deleted: true,
    videoId: cleanVideoId,
    firebaseDeleted: true,
    googleDriveFileId: Boolean(driveFileId),
    driveDeleteAttempted: drive.attempted,
    driveDeleted: Boolean(drive.deleted || drive.alreadyMissing),
    driveDeletePending: Boolean(driveFileId) && !drive.deleted && !drive.alreadyMissing,
    driveDeleteError: drive.error || "",
  };
}

export async function saveCanonicalStory({ db, uid, story }) {
  if (!db || !uid || !story?.id) return;
  await db.ref(canonicalStoryPath(uid, story.id)).set(cleanForRealtime(story));
  await db.ref(`${canonicalUserRoot(uid)}/stats/storiesCount`).transaction(
    (current) => Math.max(0, Number(current) || 0) + 1,
  );
}

export async function deleteCanonicalStory({ db, uid, storyId }) {
  if (!db || !uid || !storyId) return;
  await db.ref(`${canonicalUserRoot(uid)}/content/stories/${storyId}`).remove();
  await db.ref(`${canonicalUserRoot(uid)}/stats/storiesCount`).transaction(
    (current) => Math.max(0, (Number(current) || 0) - 1),
  );
}

export async function setCanonicalVideoEngagement({ db, ownerUid, mediaId, kind, actorUid, value, count }) {
  if (!db || !ownerUid || !mediaId || !actorUid) return;
  const base = `${canonicalUserRoot(ownerUid)}/engagement/videos/${mediaId}`;
  const plural = kind === "comment" ? "comments" : kind === "save" ? "saves" : "likes";
  await db.ref(`${base}/${plural}/${actorUid}`).set(value ? true : null);
  if (count !== undefined) {
    await db.ref(`${base}/${plural}Count`).set(Number(count) || 0);
  }
}

export async function saveCanonicalComment({ db, ownerUid, mediaId, comment }) {
  if (!db || !ownerUid || !mediaId || !comment?.id) return;
  await db.ref(`${canonicalUserRoot(ownerUid)}/engagement/videos/${mediaId}/comments/${comment.id}`).set(
    cleanForRealtime(comment),
  );
  await db.ref(`${canonicalUserRoot(ownerUid)}/engagement/videos/${mediaId}/commentsCount`).transaction(
    (current) => Math.max(0, Number(current) || 0) + 1,
  );
}
