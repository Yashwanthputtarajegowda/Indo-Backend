import { createNotification } from './notifications.js';

async function syncFollowCounts({ db, followerUid, targetUid }) {
  const [followingSnapshot, followersSnapshot] = await Promise.all([
    db.ref(`users/${followerUid}/following`).get(),
    db.ref(`users/${targetUid}/followers`).get()
  ]);
  const followingCount = followingSnapshot.exists() ? Object.keys(followingSnapshot.val() || {}).length : 0;
  const followersCount = followersSnapshot.exists() ? Object.keys(followersSnapshot.val() || {}).length : 0;
  await db.ref().update({
    [`users/${followerUid}/followingCount`]: followingCount,
    [`users/${targetUid}/followersCount`]: followersCount
  });
  return { followingCount, followersCount };
}

export async function toggleFollow({ db, followerUid, targetUid, follow }) {
  if (!db) throw new Error('Firebase Admin is not configured on the backend.');
  if (!followerUid || !targetUid) throw new Error('Both users are required.');
  if (followerUid === targetUid) throw new Error('You cannot follow your own account.');

  const [followerSnapshot, targetSnapshot] = await Promise.all([
    db.ref(`users/${followerUid}`).get(),
    db.ref(`users/${targetUid}`).get()
  ]);
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
  const requestPath = `users/${targetUid}/followRequests/${followerUid}`;
  const outgoingPath = `users/${followerUid}/sentFollowRequests/${targetUid}`;

  if (follow) {
    if (target.accountType === 'private') {
      await db.ref().update({
        [requestPath]: followerEntry,
        [outgoingPath]: targetEntry
      });
      await createNotification({
        db,
        recipientUid: targetUid,
        type: 'follow-request',
        actorUid: followerUid,
        actorName: follower.name || 'Indo User',
        actorUserId: follower.username || '',
        text: 'requested to follow you',
        targetId: target.username || ''
      });
      return {
        following: false,
        pending: true,
        followingCount: Number(follower.followingCount || 0),
        followersCount: Number(target.followersCount || 0)
      };
    }

    await db.ref().update({
      [followerPath]: targetEntry,
      [targetPath]: followerEntry,
      [requestPath]: null,
      [outgoingPath]: null
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
      [targetPath]: null,
      [requestPath]: null,
      [outgoingPath]: null
    });
  }

  const counts = await syncFollowCounts({ db, followerUid, targetUid });
  return {
    following: Boolean(follow),
    pending: false,
    ...counts
  };
}

export async function getFollowStatus({ db, followerUid, targetUid }) {
  if (!db || !followerUid || !targetUid) return { following: false, pending: false };
  if (followerUid === targetUid) return { following: false, pending: false };
  const [followerSnapshot, targetSnapshot] = await Promise.all([
    db.ref(`users/${followerUid}`).get(),
    db.ref(`users/${targetUid}`).get()
  ]);
  const following = followerSnapshot.child(`following/${targetUid}`).exists();
  const pending = targetSnapshot.child(`followRequests/${followerUid}`).exists();
  return { following, pending, private: targetSnapshot.val()?.accountType === 'private' };
}

export async function respondToFollowRequest({ db, ownerUid, requesterUid, accept }) {
  if (!db || !ownerUid || !requesterUid) throw new Error('Both users are required.');
  if (ownerUid === requesterUid) throw new Error('Invalid follow request.');
  const [ownerSnapshot, requesterSnapshot] = await Promise.all([
    db.ref(`users/${ownerUid}`).get(),
    db.ref(`users/${requesterUid}`).get()
  ]);
  if (!ownerSnapshot.exists() || !requesterSnapshot.exists()) throw new Error('Profile not found.');

  const owner = ownerSnapshot.val() || {};
  const requester = requesterSnapshot.val() || {};
  const requesterEntry = { uid: requesterUid, userId: requester.username || `@${requesterUid.slice(0, 8)}`, name: requester.name || 'Indo User' };
  const ownerEntry = { uid: ownerUid, userId: owner.username || `@${ownerUid.slice(0, 8)}`, name: owner.name || 'Indo User' };
  const requestPath = `users/${ownerUid}/followRequests/${requesterUid}`;
  const outgoingPath = `users/${requesterUid}/sentFollowRequests/${ownerUid}`;
  const followerPath = `users/${ownerUid}/followers/${requesterUid}`;
  const followingPath = `users/${requesterUid}/following/${ownerUid}`;

  if (accept) {
    await db.ref().update({
      [requestPath]: null,
      [outgoingPath]: null,
      [followerPath]: requesterEntry,
      [followingPath]: ownerEntry
    });
    await createNotification({
      db,
      recipientUid: requesterUid,
      type: 'follow-accepted',
      actorUid: ownerUid,
      actorName: owner.name || 'Indo User',
      actorUserId: owner.username || '',
      text: 'accepted your follow request',
      targetId: owner.username || ''
    });
    const [followingSnapshot, followersSnapshot] = await Promise.all([
      db.ref(`users/${requesterUid}/following`).get(),
      db.ref(`users/${ownerUid}/followers`).get()
    ]);
    const followingCount = followingSnapshot.exists() ? Object.keys(followingSnapshot.val() || {}).length : 0;
    const followersCount = followersSnapshot.exists() ? Object.keys(followersSnapshot.val() || {}).length : 0;
    await db.ref().update({
      [`users/${requesterUid}/followingCount`]: followingCount,
      [`users/${ownerUid}/followersCount`]: followersCount
    });
    return { ok: true, accepted: true, followingCount, followersCount };
  }

  await db.ref().update({ [requestPath]: null, [outgoingPath]: null });
  return { ok: true, accepted: false };
}
