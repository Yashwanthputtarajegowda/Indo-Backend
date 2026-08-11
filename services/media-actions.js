export async function toggleMediaLike({ db, uid, mediaId, like }) {
  if (!db) throw new Error('Firebase Admin is not configured.');
  if (!uid || !mediaId) throw new Error('User and media are required.');
  const likeRef = db.ref(`mediaLikes/${mediaId}/${uid}`);
  const countRef = db.ref(`videos/${mediaId}/likes`);
  const current = await likeRef.get();
  const currentlyLiked = current.exists();
  if (like && !currentlyLiked) {
    await likeRef.set({ uid, createdAt: Date.now() });
    const result = await countRef.transaction((value) => (Number(value) || 0) + 1);
    return { liked: true, likes: Number(result.snapshot.val()) || 0 };
  }
  if (!like && currentlyLiked) {
    await likeRef.remove();
    const result = await countRef.transaction((value) => Math.max(0, (Number(value) || 0) - 1));
    return { liked: false, likes: Number(result.snapshot.val()) || 0 };
  }
  const likesSnapshot = await countRef.get();
  return { liked: currentlyLiked, likes: Number(likesSnapshot.val()) || 0 };
}

export async function getMediaLikeStatus({ db, uid, mediaId }) {
  if (!db) throw new Error('Firebase Admin is not configured.');
  const [likeSnapshot, countSnapshot] = await Promise.all([
    db.ref(`mediaLikes/${mediaId}/${uid}`).get(),
    db.ref(`videos/${mediaId}/likes`).get()
  ]);
  return { liked: likeSnapshot.exists(), likes: Number(countSnapshot.val()) || 0 };
}
