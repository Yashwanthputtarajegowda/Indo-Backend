// Canonical per-user schema helper. See main migration for the authoritative layout.
const PROFILE_FIELDS = ['uid','username','userId','name','displayName','bio','photoURL','avatarUrl','createdAt','updatedAt','accountType','isVerified'];
const compact = (value) => Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== ''));
export const canonicalUserRoot = (uid) => `users/${String(uid || '').trim()}`;
function legacyUserValue(user, field) { return user?.profile?.[field] ?? user?.[field]; }
function mergeRelationValues(canonicalValue, legacyValue) {
  const canonical = canonicalValue && typeof canonicalValue === 'object' ? canonicalValue : {};
  const legacy = legacyValue && typeof legacyValue === 'object' ? legacyValue : {};
  return { ...legacy, ...canonical };
}
async function readRelation(db, uid, relation) {
  const [canonicalSnapshot, legacySnapshot] = await Promise.all([
    db.ref(`${canonicalUserRoot(uid)}/social/${relation}`).get(),
    db.ref(`${canonicalUserRoot(uid)}/${relation}`).get(),
  ]);
  return mergeRelationValues(canonicalSnapshot.val(), legacySnapshot.val());
}
export async function syncCanonicalUser({ db, uid, includeContent = true }) {
  const cleanUid = String(uid || '').trim(); if (!db || !cleanUid) throw new Error('User is required.');
  const userRef = db.ref(canonicalUserRoot(cleanUid)); const userSnapshot = await userRef.get(); if (!userSnapshot.exists()) throw new Error('Profile not found.'); const user = userSnapshot.val() || {};
  const [followers, following, verificationSnapshot] = await Promise.all([readRelation(db, cleanUid, 'followers'), readRelation(db, cleanUid, 'following'), userRef.child('verification').get()]);
  const contentVideos = {}, contentStories = {}, engagementVideos = {};
  if (includeContent) {
    const [videosSnapshot, storiesSnapshot, likesSnapshot, commentsSnapshot, savesSnapshot] = await Promise.all([db.ref('videos').get(), db.ref('stories').get(), db.ref('videoLikes').get(), db.ref('videoComments').get(), db.ref('videoSaves').get()]);
    const videos = videosSnapshot.val() || {}, likes = likesSnapshot.val() || {}, comments = commentsSnapshot.val() || {}, saves = savesSnapshot.val() || {};
    for (const [id, item] of Object.entries(videos)) {
      if (!item || String(item.ownerUid || '') !== cleanUid) continue;
      const video = { ...item, id: String(item.id || id) };
      contentVideos[id] = video;
      const likeMap = likes[id] || {};
      const commentMap = comments[id] || {};
      const saveMap = saves[id] || {};
      engagementVideos[id] = {
        likes: likeMap,
        comments: commentMap,
        saves: saveMap,
        views: Number(video.views || 0),
        likesCount: Object.keys(likeMap).filter((uidKey) => Boolean(likeMap[uidKey])).length,
        commentsCount: Object.keys(commentMap).filter((commentKey) => Boolean(commentMap[commentKey])).length,
        savesCount: Object.keys(saveMap).filter((uidKey) => Boolean(saveMap[uidKey])).length,
      };
    }
    for (const [id, item] of Object.entries(storiesSnapshot.val() || {})) {
      if (!item || String(item.ownerUid || '') !== cleanUid) continue;
      contentStories[id] = { ...item, id: String(item.id || id) };
    }
  }
  const profile = compact(Object.fromEntries(PROFILE_FIELDS.map((field) => [field, legacyUserValue(user, field)])));
  profile.uid = cleanUid; profile.username = profile.username || user.username || user.userId || '';
  const profilePrivate = compact({ email: user.profilePrivate?.email ?? user.email, phoneNumber: user.profilePrivate?.phoneNumber ?? user.phoneNumber, mobile: user.profilePrivate?.mobile ?? user.mobile });
  const followersCount = Object.keys(followers).length, followingCount = Object.keys(following).length, postsCount = Object.keys(contentVideos).length, storiesCount = Object.keys(contentStories).length;
  let viewsCount = 0, likesCount = 0, commentsCount = 0, savesCount = 0;
  for (const engagement of Object.values(engagementVideos)) {
    viewsCount += Number(engagement.views || 0);
    likesCount += Number(engagement.likesCount || 0);
    commentsCount += Number(engagement.commentsCount || 0);
    savesCount += Number(engagement.savesCount || 0);
  }
  const canonical = {
    profile,
    profilePrivate,
    verification: verificationSnapshot.val() || user.verification || {},
    settings: { ...(user.settings || {}), accountType: user.settings?.accountType || user.accountType || 'public' },
    social: { followers, following, followersCount, followingCount },
    content: { posts: contentVideos, videos: contentVideos, stories: contentStories },
    engagement: { videos: engagementVideos },
    stats: { postsCount, videosCount: postsCount, storiesCount, followersCount, followingCount, viewsCount, likesCount, commentsCount, savesCount, updatedAt: Date.now() },
  };
  await userRef.update(canonical);
  return canonical;
}
export function canonicalFollowUpdate({ followerUid, targetUid, followerEntry, targetEntry, follow }) {
  const update = {};
  update[`${canonicalUserRoot(followerUid)}/social/following/${targetUid}`] = follow ? targetEntry : null;
  update[`${canonicalUserRoot(targetUid)}/social/followers/${followerUid}`] = follow ? followerEntry : null;
  return update;
}
export async function migrateAllUsersToCanonical({ db }) {
  if (!db) throw new Error('Firebase database is not configured.');
  const users = (await db.ref('users').get()).val() || {};
  const updates = {};
  const [videosSnapshot, storiesSnapshot, likesSnapshot, commentsSnapshot, savesSnapshot] = await Promise.all([db.ref('videos').get(), db.ref('stories').get(), db.ref('videoLikes').get(), db.ref('videoComments').get(), db.ref('videoSaves').get()]);
  const videos = videosSnapshot.val() || {}, stories = storiesSnapshot.val() || {}, likes = likesSnapshot.val() || {}, comments = commentsSnapshot.val() || {}, saves = savesSnapshot.val() || {};
  const byOwnerVideos = {}, byOwnerStories = {}, byOwnerEngagement = {};
  for (const [id, video] of Object.entries(videos)) {
    const ownerUid = String(video?.ownerUid || '').trim(); if (!ownerUid) continue;
    byOwnerVideos[ownerUid] ||= {}; byOwnerEngagement[ownerUid] ||= {};
    const likeMap = likes[id] || {}, commentMap = comments[id] || {}, saveMap = saves[id] || {};
    byOwnerVideos[ownerUid][id] = { ...video, id: String(video.id || id) };
    byOwnerEngagement[ownerUid][id] = {
      likes: likeMap,
      comments: commentMap,
      saves: saveMap,
      views: Number(video.views || 0),
      likesCount: Object.keys(likeMap).filter((uidKey) => Boolean(likeMap[uidKey])).length,
      commentsCount: Object.keys(commentMap).filter((commentKey) => Boolean(commentMap[commentKey])).length,
      savesCount: Object.keys(saveMap).filter((uidKey) => Boolean(saveMap[uidKey])).length,
    };
  }
  for (const [id, story] of Object.entries(stories)) {
    const ownerUid = String(story?.ownerUid || '').trim(); if (!ownerUid) continue;
    byOwnerStories[ownerUid] ||= {}; byOwnerStories[ownerUid][id] = { ...story, id: String(story.id || id) };
  }
  for (const uid of Object.keys(users)) {
    const root = canonicalUserRoot(uid), user = users[uid] || {};
    const followers = mergeRelationValues(user.social?.followers, user.followers);
    const following = mergeRelationValues(user.social?.following, user.following);
    const profile = compact(Object.fromEntries(PROFILE_FIELDS.map((field) => [field, legacyUserValue(user, field)])));
    profile.uid = uid; profile.username = profile.username || user.username || user.userId || '';
    const profilePrivate = compact({ email: user.profilePrivate?.email ?? user.email, phoneNumber: user.profilePrivate?.phoneNumber ?? user.phoneNumber, mobile: user.profilePrivate?.mobile ?? user.mobile });
    const userVideos = byOwnerVideos[uid] || {}, userStories = byOwnerStories[uid] || {}, userEngagement = byOwnerEngagement[uid] || {};
    let viewsCount = 0, likesCount = 0, commentsCount = 0, savesCount = 0;
    for (const engagement of Object.values(userEngagement)) {
      viewsCount += Number(engagement.views || 0);
      likesCount += Number(engagement.likesCount || 0);
      commentsCount += Number(engagement.commentsCount || 0);
      savesCount += Number(engagement.savesCount || 0);
    }
    updates[`${root}/profile`] = profile;
    updates[`${root}/profilePrivate`] = profilePrivate;
    updates[`${root}/verification`] = user.verification || {};
    updates[`${root}/settings`] = { ...(user.settings || {}), accountType: user.settings?.accountType || user.accountType || 'public' };
    updates[`${root}/social`] = { followers, following, followersCount: Object.keys(followers).length, followingCount: Object.keys(following).length };
    updates[`${root}/content`] = { posts: userVideos, videos: userVideos, stories: userStories };
    updates[`${root}/engagement`] = { videos: userEngagement };
    updates[`${root}/stats`] = { postsCount: Object.keys(userVideos).length, videosCount: Object.keys(userVideos).length, storiesCount: Object.keys(userStories).length, followersCount: Object.keys(followers).length, followingCount: Object.keys(following).length, viewsCount, likesCount, commentsCount, savesCount, updatedAt: Date.now() };
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
  await db.ref('system/canonicalSchemaVersion').set({ version: 4, migratedAt: Date.now(), users: Object.keys(users).length });
  return { ok: true, users: Object.keys(users).length };
}
