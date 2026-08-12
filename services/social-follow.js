import { createNotification } from './notifications.js';

export async function toggleFollow({ db, followerUid, targetUid, follow }) {
  if (!db) throw new Error('Firebase Admin is not configured on the backend.');
  if (!followerUid || !targetUid) throw new Error('Both users are required.');
  if (followerUid === targetUid) throw new Error('You cannot follow your own account.');

  const followerSnapshot = await db.ref(`users/${followerUid}`).get();
  const targetSnapshot = await db.ref(`users/${targetUid}`).get();
  if (!targetSnapshot.exists()) throw new Error('Target profile not found.');

  const follower = followerSnapshot.val() || {};
  const target = targetSnapshot.val() || {};
  const followerEntry = {
    uid: followerUid,
    userId: follower.username || `@${followerUid.slice(0, 8)}`,
    name: follower.name || 'Indo User'
  };
  const targetEntry = {
    uid: targetUid,
    userId: target.username || `@${targetUid.slice(0, 8)}`,
    name: target.name || 'Indo User'
  };

  const followerPath = `users/${followerUid}/following/${targetUid}`;
  const targetPath = `users/${targetUid}/followers/${followerUid}`;

  if (follow) {
    await db.ref().update({
      [followerPath]: targetEntry,
      [targetPath]: followerEntry
    });

    await createNotification({
      db,
      recipientUid: targetUid,
      type: 'follow',
      actorUid: followerUid,
      actorName: follower.name || 'Indo User',
      actorUserId: follower.username || '',
      text: 'started following you',
      targetId: target.username || ''
    });
  } else {
    await db.ref().update({
      [followerPath]: null,
      [targetPath]: null
    });
  }

  const [followingSnapshot, followersSnapshot] = await Promise.all([
    db.ref(`users/${followerUid}/following`).get(),
    db.ref(`users/${targetUid}/followers`).get()
  ]);

  return {
    following: follow,
    followingCount: followingSnapshot.exists() ? Object.keys(followingSnapshot.val() || {}).length : 0,
    followersCount: followersSnapshot.exists() ? Object.keys(followersSnapshot.val() || {}).length : 0
  };
}

export async function getFollowStatus({ db, followerUid, targetUid }) {
  if (!db || !followerUid || !targetUid) return { following: false };
  if (followerUid === targetUid) return { following: false };
  const snapshot = await db.ref(`users/${followerUid}/following/${targetUid}`).get();
  return { following: snapshot.exists() };
}
