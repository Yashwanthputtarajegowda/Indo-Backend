const DEFAULT_LIMIT = 50;

function parseLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(DEFAULT_LIMIT, Math.max(1, Math.floor(parsed)));
}

export function installReadGuards(app) {
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (!req.path.startsWith("/api")) return next();

    if (req.query?.limit !== undefined) {
      const limit = parseLimit(req.query.limit);
      req.query.limit = String(limit);
    }

    if (req.query?.pageSize !== undefined) {
      const pageSize = parseLimit(req.query.pageSize);
      req.query.pageSize = String(pageSize);
    }

    if (req.query?.offset !== undefined) {
      const raw = Number(req.query.offset);
      req.query.offset = String(
        Number.isFinite(raw) ? Math.min(1000, Math.max(0, Math.floor(raw))) : 0,
      );
    }

    if (req.url.length > 4096)
      return res.status(414).json({ ok: false, error: "Request is too large." });

    return next();
  });
}
