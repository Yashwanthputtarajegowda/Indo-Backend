const PROFILE_FIELDS = ['uid','username','userId','name','displayName','bio','photoURL','avatarUrl','email','phoneNumber','mobile','createdAt','updatedAt','accountType','isVerified'];

function compact(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined && item !== null && item !== '') out[key] = item;
  }
  return out;
}

export function canonicalUserRoot(uid) {
  return `users/${String(uid).trim()}`;
}

export async function syncCanonicalUser({ db, uid, includeContent = true }) {
  const cleanUid = String(uid || '').trim();
  if (!db || !cleanUid) throw new Error('User is required.');

  const userRef = db.ref(canonicalUserRoot(cleanUid));
  const userSnapshot = await userRef.get();
  if (!userSnapshot.exists()) throw new Error('Profile not found.');
  const user = userSnapshot.val() || {};

  const [followersSnapshot, followingSnapshot, verificationSnapshot] = await Promise.all([
    userRef.child('followers').get(),
    userRef.child('following').get(),
    userRef.child('verification').get(),
  ]);

  const followers = followersSnapshot.val() || {};
  const following = followingSnapshot.val() || {};
  const verification = verificationSnapshot.val() || {};
  const followersCount = Object.keys(followers).length;
  const followingCount = Object.keys(following).length;

  const profile = compact(Object.fromEntries(PROFILE_FIELDS
    .filter((field) => user[field] !== undefined)
    .map((field) => [field, user[field]])));
  profile.uid = cleanUid;
  profile.username = profile.username || user.username || user.userId || '';

  const contentVideos = {};
  const contentStories = {};
  let postsCount = 0;

  if (includeContent) {
    const [videosSnapshot, storiesSnapshot] = await Promise.all([
      db.ref('videos').get(),
      db.ref('stories').get(),
    ]);
    for (const item of Object.values(videosSnapshot.val() || {})) {
      if (!item || String(item.ownerUid || '') !== cleanUid) continue;
      const id = String(item.id || '').trim();
      if (!id) continue;
      contentVideos[id] = item;
      postsCount += 1;
    }
    for (const [id, item] of Object.entries(storiesSnapshot.val() || {})) {
      if (!item || String(item.ownerUid || '') !== cleanUid) continue;
      contentStories[id] = item;
    }
  }

  const canonical = {
    profile,
    settings: {
      accountType: user.accountType || 'public',
    },
    verification,
    social: {
      followers,
      following,
      followersCount,
      followingCount,
    },
    content: {
      videos: contentVideos,
      stories: contentStories,
    },
    stats: {
      followersCount,
      followingCount,
      postsCount,
      storiesCount: Object.keys(contentStories).length,
      updatedAt: Date.now(),
    },
  };

  await userRef.update({
    profile: canonical.profile,
    settings: canonical.settings,
    verification: canonical.verification,
    social: canonical.social,
    content: canonical.content,
    stats: canonical.stats,
  });

  return canonical;
}

export function canonicalFollowUpdate({ followerUid, targetUid, followerEntry, targetEntry, follow }) {
  const update = {};
  const followerRoot = canonicalUserRoot(followerUid);
  const targetRoot = canonicalUserRoot(targetUid);
  update[`${followerRoot}/social/following/${targetUid}`] = follow ? targetEntry : null;
  update[`${targetRoot}/social/followers/${followerUid}`] = follow ? followerEntry : null;
  return update;
}
