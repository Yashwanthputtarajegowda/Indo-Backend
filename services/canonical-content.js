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

export function canonicalVideoPath(uid, videoId) { return `${canonicalUserRoot(uid)}/content/videos/${videoId}`; }
export function canonicalStoryPath(uid, storyId) { return `${canonicalUserRoot(uid)}/content/stories/${storyId}`; }

export async function saveCanonicalVideo({ db, uid, video }) {
  if (!db || !uid || !video?.id) return;
  const root = canonicalUserRoot(uid);
  const safeVideo = cleanForRealtime({ ...video, tags: Array.isArray(video.tags) ? video.tags : [] });
  await db.ref().update({
    [`${root}/content/posts/${video.id}`]: safeVideo,
    [`${root}/content/videos/${video.id}`]: safeVideo,
  });
}

export async function updateCanonicalVideoViews({ db, uid, videoId, views }) {
  if (!db || !uid || !videoId) return;
  await db.ref(`${canonicalVideoPath(uid, videoId)}/views`).set(Number(views) || 0);
  await db.ref(`${canonicalUserRoot(uid)}/stats/viewsCount`).transaction((current) => Math.max(0, Number(current) || 0) + 1);
}

async function readVideoRecord(db, uid, videoId) {
  const cleanVideoId = String(videoId || "").trim();
  if (!cleanVideoId) return null;

  const rootSnapshot = await db.ref(`videos/${cleanVideoId}`).get();
  if (rootSnapshot.exists()) return rootSnapshot.val() || {};

  // Some older/canonical records may no longer have a duplicate at /videos/{id}.
  // Fall back to the authenticated user's canonical content before reporting 404.
  const canonicalSnapshot = await db.ref(canonicalVideoPath(uid, cleanVideoId)).get();
  if (canonicalSnapshot.exists()) return canonicalSnapshot.val() || {};

  return null;
}

function driveFileIdFromVideo(video) {
  return String(
    video?.googleDrive?.fileId ||
    video?.drive?.fileId ||
    video?.storage?.fileId ||
    video?.googleDriveFileId ||
    "",
  ).trim();
}

export async function deleteCanonicalVideo({ db, uid, videoId, googleDriveFileId = "" }) {
  if (!db || !uid) return { deleted: false, missingInput: true };
  const cleanVideoId = String(videoId || "").trim();
  if (!cleanVideoId) return { deleted: false, missingInput: true };

  const sourceVideo = await readVideoRecord(db, uid, cleanVideoId);
  if (!sourceVideo) return { deleted: false, missing: true, videoId: cleanVideoId };

  const ownerUid = String(sourceVideo.ownerUid || "").trim();
  if (ownerUid && ownerUid !== String(uid).trim()) {
    const error = new Error("You can delete only your own video.");
    error.status = 403;
    throw error;
  }

  const provider = String(sourceVideo.storage?.provider || "").trim().toLowerCase();
  const driveFileId = String(googleDriveFileId || driveFileIdFromVideo(sourceVideo)).trim();

  if (provider === "google-drive" && !driveFileId) {
    const error = new Error("Google Drive file ID is missing for this video.");
    error.status = 409;
    error.code = "DRIVE_FILE_ID_MISSING";
    throw error;
  }

  if (driveFileId) {
    const driveResult = await deleteDriveFile(driveFileId);
    if (!driveResult?.deleted && !driveResult?.alreadyMissing) {
      const error = new Error("Google Drive file could not be deleted.");
      error.status = 502;
      error.code = "DRIVE_DELETE_FAILED";
      throw error;
    }
  }

  const canonicalRoot = canonicalUserRoot(uid);
  await db.ref().update({
    [`videos/${cleanVideoId}`]: null,
    [`${canonicalRoot}/content/posts/${cleanVideoId}`]: null,
    [`${canonicalRoot}/content/videos/${cleanVideoId}`]: null,
    [`${canonicalRoot}/content/stories/${cleanVideoId}`]: null,
    [`${canonicalRoot}/engagement/videos/${cleanVideoId}`]: null,
    [`videoLikes/${cleanVideoId}`]: null,
    [`videoComments/${cleanVideoId}`]: null,
    [`videoSaves/${cleanVideoId}`]: null,
  });

  return {
    deleted: true,
    videoId: cleanVideoId,
    firebaseDeleted: true,
    storageProvider: provider,
    googleDriveFileId: Boolean(driveFileId),
    driveDeleted: Boolean(driveFileId),
    driveDeleteVerified: Boolean(driveFileId),
  };
}

export async function saveCanonicalStory({ db, uid, story }) {
  if (!db || !uid || !story?.id) return;
  await db.ref(canonicalStoryPath(uid, story.id)).set(cleanForRealtime(story));
  await db.ref(`${canonicalUserRoot(uid)}/stats/storiesCount`).transaction((current) => Math.max(0, Number(current) || 0) + 1);
}

export async function deleteCanonicalStory({ db, uid, storyId }) {
  if (!db || !uid || !storyId) return;
  await db.ref(`${canonicalUserRoot(uid)}/content/stories/${storyId}`).remove();
  await db.ref(`${canonicalUserRoot(uid)}/stats/storiesCount`).transaction((current) => Math.max(0, (Number(current) || 0) - 1));
}

export async function setCanonicalVideoEngagement({ db, ownerUid, mediaId, kind, actorUid, value, count }) {
  if (!db || !ownerUid || !mediaId || !actorUid) return;
  const base = `${canonicalUserRoot(ownerUid)}/engagement/videos/${mediaId}`;
  const plural = kind === "comment" ? "comments" : kind === "save" ? "saves" : "likes";
  await db.ref(`${base}/${plural}/${actorUid}`).set(value ? true : null);
  if (count !== undefined) await db.ref(`${base}/${plural}Count`).set(Number(count) || 0);
}

export async function saveCanonicalComment({ db, ownerUid, mediaId, comment }) {
  if (!db || !ownerUid || !mediaId || !comment?.id) return;
  await db.ref(`${canonicalUserRoot(ownerUid)}/engagement/videos/${mediaId}/comments/${comment.id}`).set(cleanForRealtime(comment));
  await db.ref(`${canonicalUserRoot(ownerUid)}/engagement/videos/${mediaId}/commentsCount`).transaction((current) => Math.max(0, Number(current) || 0) + 1);
}
