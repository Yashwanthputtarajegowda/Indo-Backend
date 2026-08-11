export async function listComments({ db, reelId, limit = 50 }) {
  const snapshot = await db.ref(`reelComments/${reelId}`).limitToLast(Math.min(100, Math.max(1, limit))).get();
  return Object.values(snapshot.val() || {}).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}

export async function addComment({ db, reelId, uid, text, profile }) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) throw new Error('Comment cannot be empty.');
  const commentRef = db.ref(`reelComments/${reelId}`).push();
  const comment = {
    id: commentRef.key,
    reelId,
    uid,
    userId: profile?.username || `@${uid.slice(0, 8)}`,
    name: profile?.name || 'Indo User',
    text: clean,
    createdAt: Date.now()
  };
  await commentRef.set(comment);
  return comment;
}
