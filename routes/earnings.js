function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function hours(seconds) {
  return asNumber(seconds) / 3600;
}

async function loadUser(db, uid) {
  const snapshot = await db.ref(`users/${uid}`).get();
  return snapshot.exists() ? snapshot.val() || {} : {};
}

async function calculateSummary({ db, uid }) {
  const [userSnapshot, videosSnapshot] = await Promise.all([
    db.ref(`users/${uid}`).get(),
    db.ref('videos').orderByChild('ownerUid').equalTo(uid).get()
  ]);

  const user = userSnapshot.val() || {};
  const videos = Object.values(videosSnapshot.val() || {});
  const videoViews = videos
    .filter((item) => (item.mediaType || 'video') === 'video')
    .reduce((sum, item) => sum + asNumber(item.views), 0);
  const reelViews = videos
    .filter((item) => item.mediaType === 'reel')
    .reduce((sum, item) => sum + asNumber(item.views), 0);

  const videoWatchSeconds = asNumber(user.earnings?.videoWatchSeconds);
  const reelWatchSeconds = asNumber(user.earnings?.reelWatchSeconds);
  const videoWatchHours = hours(videoWatchSeconds);
  const reelWatchHours = hours(reelWatchSeconds);
  const videoEligible = videoWatchHours >= 5000;
  const reelEligible = reelWatchHours >= 1000;
  const eligible = videoEligible && reelEligible;
  const earningOn = user.earnings?.enabled === true;

  const videoRevenue = earningOn ? (videoViews / 1000) * 0.50 : 0;
  const reelRevenue = earningOn ? (reelViews / 1000) * 0.10 : 0;
  const estimatedRevenue = videoRevenue + reelRevenue;
  const payableBalance = earningOn ? estimatedRevenue : 0;

  return {
    videoViews,
    reelViews,
    videoWatchSeconds,
    reelWatchSeconds,
    videoWatchHours,
    reelWatchHours,
    videoEligible,
    reelEligible,
    eligible,
    earningOn,
    rates: { videoPerThousandViews: 0.50, reelPerThousandViews: 0.10 },
    videoRevenue,
    reelRevenue,
    estimatedRevenue,
    payableBalance
  };
}

export function createEarningsRouter({ db, requireUser }) {
  const router = (await import('express')).default.Router();

  router.get('/earnings/status', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    try {
      const summary = await calculateSummary({ db, uid: user.uid });
      return res.json({ ok: true, ...summary });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not load earning status.' });
    }
  });

  router.get('/earnings/summary', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    try {
      const summary = await calculateSummary({ db, uid: user.uid });
      return res.json({ ok: true, ...summary });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not load earning summary.' });
    }
  });

  router.post('/earnings/toggle', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    const enabled = req.body?.enabled === true;
    try {
      const summary = await calculateSummary({ db, uid: user.uid });
      if (enabled && !summary.eligible) {
        return res.status(403).json({
          ok: false,
          error: 'Earning is locked until both watch-hour requirements are completed.',
          eligible: false,
          videoWatchHours: summary.videoWatchHours,
          reelWatchHours: summary.reelWatchHours
        });
      }
      await db.ref(`users/${user.uid}/earnings`).update({
        enabled,
        enabledAt: enabled ? Date.now() : null
      });
      return res.json({ ok: true, enabled });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not update earning status.' });
    }
  });

  router.post('/earnings/watch-progress', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: 'Firebase Admin is not configured on the backend.' });
    const mediaId = String(req.body?.mediaId || '').trim();
    const requestedSeconds = asNumber(req.body?.seconds);
    if (!mediaId || requestedSeconds <= 0) {
      return res.status(400).json({ ok: false, error: 'Media ID and positive watch time are required.' });
    }
    const seconds = Math.min(15, requestedSeconds);
    try {
      const mediaSnapshot = await db.ref(`videos/${mediaId}`).get();
      if (!mediaSnapshot.exists()) return res.status(404).json({ ok: false, error: 'Media not found.' });
      const media = mediaSnapshot.val() || {};
      if (media.ownerUid === user.uid) return res.json({ ok: true, counted: false, seconds: 0 });

      const type = media.mediaType === 'reel' ? 'reel' : 'video';
      const counterPath = `users/${media.ownerUid}/earnings/${type}WatchSeconds`;
      const viewerPath = `users/${media.ownerUid}/earnings/watchers/${user.uid}/${type}/${mediaId}`;
      const counter = await db.ref(counterPath).transaction((current) => asNumber(current) + seconds);
      await db.ref(viewerPath).transaction((current) => asNumber(current) + seconds);

      return res.json({
        ok: true,
        counted: true,
        seconds,
        mediaType: type,
        totalWatchSeconds: asNumber(counter.snapshot.val())
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Could not record watch progress.' });
    }
  });

  return router;
}
