export async function createNotification({ db, recipientUid, type, actorUid, actorName = '', actorUserId = '', text = '', targetId = '' }) {
  if (!recipientUid || !type || !actorUid || actorUid === recipientUid) return null;
  const notificationRef = db.ref(`notifications/${recipientUid}`).push();
  const notification = {
    id: notificationRef.key,
    type,
    actorUid,
    actorName,
    actorUserId,
    text,
    targetId,
    read: false,
    createdAt: Date.now()
  };
  await notificationRef.set(notification);
  return notification;
}

export async function listNotifications({ db, uid, limit = 50 }) {
  const snapshot = await db.ref(`notifications/${uid}`).limitToLast(Math.min(100, Math.max(1, limit))).get();
  return Object.values(snapshot.val() || {}).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

export async function markNotificationRead({ db, uid, notificationId }) {
  await db.ref(`notifications/${uid}/${notificationId}/read`).set(true);
}
