import express from 'express';

const appProto = express.application;
if (appProto.__indoTelegramOnlyVideoPolicy) {
  // Already installed.
} else {
  const originalPost = appProto.post;
  const originalGet = appProto.get;

  appProto.post = function telegramOnlyPost(path, ...handlers) {
    const routePath = String(path || '');

    // Disable the legacy Cloudinary video publish endpoint.
    if (routePath === '/api/media/videos') {
      return originalPost.call(this, path, (req, res) => {
        return res.status(410).json({
          ok: false,
          error: 'Legacy Cloudinary video publishing is disabled. Use Telegram storage.',
        });
      });
    }

    // Keep stories working if they still use the shared signature endpoint,
    // but never issue Cloudinary video signatures.
    if (routePath === '/api/media/signature') {
      const wrapped = handlers.map((handler) => function telegramOnlySignature(req, res, next) {
        if (String(req.body?.kind || 'video').toLowerCase() === 'video') {
          return res.status(410).json({
            ok: false,
            error: 'Cloudinary video storage is disabled. Upload videos to Telegram.',
          });
        }
        return handler(req, res, next);
      });
      return originalPost.call(this, path, ...wrapped);
    }

    // Prevent legacy delete code from calling Cloudinary.
    if (/^\/api\/media\/videos\/[^/]+\/delete$/.test(routePath)) {
      return originalPost.call(this, path, (req, res) => {
        return res.status(410).json({
          ok: false,
          error: 'Legacy Cloudinary video deletion is disabled. Telegram storage is authoritative.',
        });
      });
    }

    return originalPost.call(this, path, ...handlers);
  };

  // Keep the existing GET endpoint but hide every non-Telegram video from the
  // client, so old Cloudinary URLs are no longer used for playback.
  appProto.get = function telegramOnlyGet(path, ...handlers) {
    if (String(path || '') === '/api/media/videos') {
      const wrapped = handlers.map((handler) => function telegramOnlyVideos(req, res, next) {
        const originalJson = res.json.bind(res);
        res.json = (body) => {
          if (body && Array.isArray(body.videos)) {
            body = {
              ...body,
              videos: body.videos.filter((video) => {
                const storage = String(video?.storage?.provider || video?.storage || '').toLowerCase();
                return storage === 'telegram' || Boolean(video?.telegram?.fileId || video?.telegram?.uploadId);
              }),
            };
          }
          return originalJson(body);
        };
        return handler(req, res, next);
      });
      return originalGet.call(this, path, ...wrapped);
    }
    return originalGet.call(this, path, ...handlers);
  };

  appProto.__indoTelegramOnlyVideoPolicy = true;
  console.log('Telegram-only video storage policy enabled.');
}
