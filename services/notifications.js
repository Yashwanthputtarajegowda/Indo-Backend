export async function createNotification({
  db,
  recipientUid,
  type,
  actorUid,
  actorName = "",
  actorUserId = "",
  text = "",
  targetId = "",
}) {
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
    createdAt: Date.now(),
  };
  await notificationRef.set(notification);
  return notification;
}

export async function listNotifications({ db, uid, limit = 50 }) {
  const snapshot = await db
    .ref(`notifications/${uid}`)
    .limitToLast(Math.min(100, Math.max(1, limit)))
    .get();
  return Object.values(snapshot.val() || {}).sort(
    (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0),
  );
}

export async function countUnreadNotifications({ db, uid }) {
  const snapshot = await db
    .ref(`notifications/${uid}`)
    .orderByChild("read")
    .equalTo(false)
    .get();
  return Object.keys(snapshot.val() || {}).length;
}

export async function markNotificationRead({ db, uid, notificationId }) {
  const ref = db.ref(`notifications/${uid}/${notificationId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists()) return false;
  await ref.child("read").set(true);
  return true;
}

export async function markAllNotificationsRead({ db, uid }) {
  const ref = db.ref(`notifications/${uid}`);
  const snapshot = await ref.orderByChild("read").equalTo(false).get();
  const unread = snapshot.val() || {};
  const updates = {};
  for (const id of Object.keys(unread)) updates[`${id}/read`] = true;
  if (Object.keys(updates).length) await ref.update(updates);
  return Object.keys(updates).length;
}
