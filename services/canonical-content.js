import { canonicalUserRoot } from "./user-canonical.js";

export function canonicalVideoPath(uid, videoId) {
  return `${canonicalUserRoot(uid)}/content/videos/${videoId}`;
}

export function canonicalStoryPath(uid, storyId) {
  return `${canonicalUserRoot(uid)}/content/stories/${storyId}`;
}

export async function saveCanonicalVideo({
  db,
  uid,
  video,
}) {
  if (!db || !uid || !video?.id) return;
  const root = canonicalUserRoot(uid);
  await db.ref().update({
    [`${root}/content/posts/${video.id}`]: video,
    [`${root}/content/videos/${video.id}`]: video,
  });
}

export async function updateCanonicalVideoViews({
  db,
  uid,
  videoId,
  views,
}) {
  if (!db || !uid || !videoId) return;
  await db
    .ref(
      `${canonicalVideoPath(uid, videoId)}/views`,
    )
    .set(Number(views) || 0);
  await db
    .ref(
      `${canonicalUserRoot(uid)}/stats/viewsCount`,
    )
    .transaction(
      (current) =>
        Math.max(0, Number(current) || 0) + 1,
    );
}

export async function deleteCanonicalVideo({
  db,
  uid,
  videoId,
}) {
  if (!db || !uid || !videoId) return;
  await db.ref().update({
    [`${canonicalUserRoot(uid)}/content/posts/${videoId}`]:
      null,
    [`${canonicalUserRoot(uid)}/content/videos/${videoId}`]:
      null,
    [`${canonicalUserRoot(uid)}/engagement/videos/${videoId}`]:
      null,
  });
}

export async function saveCanonicalStory({
  db,
  uid,
  story,
}) {
  if (!db || !uid || !story?.id) return;
  await db
    .ref(`${canonicalStoryPath(uid, story.id)}`)
    .set(story);
  await db
    .ref(
      `${canonicalUserRoot(uid)}/stats/storiesCount`,
    )
    .transaction(
      (current) =>
        Math.max(0, Number(current) || 0) + 1,
    );
}

export async function deleteCanonicalStory({
  db,
  uid,
  storyId,
}) {
  if (!db || !uid || !storyId) return;
  await db
    .ref(
      `${canonicalUserRoot(uid)}/content/stories/${storyId}`,
    )
    .remove();
  await db
    .ref(
      `${canonicalUserRoot(uid)}/stats/storiesCount`,
    )
    .transaction((current) =>
      Math.max(0, (Number(current) || 0) - 1),
    );
}

export async function setCanonicalVideoEngagement({
  db,
  ownerUid,
  mediaId,
  kind,
  actorUid,
  value,
  count,
}) {
  if (!db || !ownerUid || !mediaId || !actorUid)
    return;
  const base = `${canonicalUserRoot(ownerUid)}/engagement/videos/${mediaId}`;
  const plural =
    kind === "comment"
      ? "comments"
      : kind === "save"
        ? "saves"
        : "likes";
  await db
    .ref(`${base}/${plural}/${actorUid}`)
    .set(value ? true : null);
  if (count !== undefined)
    await db
      .ref(`${base}/${plural}Count`)
      .set(Number(count) || 0);
}

export async function saveCanonicalComment({
  db,
  ownerUid,
  mediaId,
  comment,
}) {
  if (
    !db ||
    !ownerUid ||
    !mediaId ||
    !comment?.id
  )
    return;
  await db
    .ref(
      `${canonicalUserRoot(ownerUid)}/engagement/videos/${mediaId}/comments/${comment.id}`,
    )
    .set(comment);
  await db
    .ref(
      `${canonicalUserRoot(ownerUid)}/engagement/videos/${mediaId}/commentsCount`,
    )
    .transaction(
      (current) =>
        Math.max(0, Number(current) || 0) + 1,
    );
}
