import express from "express";
import { canonicalUserRoot, syncCanonicalUser } from "../services/user-canonical.js";
import { saveCanonicalVideo } from "../services/canonical-content.js";

function text(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function validSourceUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.startsWith("10.") || host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

async function probeVideo(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal, headers: { Accept: "video/*,*/*;q=0.8" } });
    return {
      ok: response.ok,
      url: response.url || url.toString(),
      contentType: String(response.headers.get("content-type") || "").toLowerCase(),
      length: Number(response.headers.get("content-length") || 0),
      acceptRanges: String(response.headers.get("accept-ranges") || "").toLowerCase(),
    };
  } catch {
    return { ok: true, url: url.toString(), contentType: "" };
  } finally {
    clearTimeout(timeout);
  }
}

function streamHeaders(res) {
  res.set({
    "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=60",
    "Accept-Ranges": "bytes",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  });
}

export function createExternalVideoLinksRouter({ db, requireUser }) {
  const router = express.Router();

  router.post("/media/external-videos", async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return;
    if (!db) return res.status(503).json({ ok: false, error: "Service unavailable." });

    const url = validSourceUrl(req.body?.url);
    if (!url || isPrivateHostname(url.hostname)) return res.status(400).json({ ok: false, error: "Please provide a valid public video URL." });

    try {
      const probe = await probeVideo(url);
      const contentType = probe.contentType;
      if (contentType && !contentType.startsWith("video/") && !/\.((mp4)|(webm)|(ogg)|(ogv))(?:$|[?#])/i.test(url.pathname)) {
        return res.status(400).json({ ok: false, error: "That URL does not appear to be a direct video file. Use the video's direct media URL." });
      }

      const title = text(req.body?.title, 120) || "Video";
      const caption = text(req.body?.caption, 500);
      const mediaType = String(req.body?.mediaType || "video").toLowerCase() === "reel" ? "reel" : "video";
      const videoRef = db.ref("videos").push();
      const videoId = String(videoRef.key);
      const baseUrl = `${req.protocol || "https"}://${req.get("host")}`;
      const streamUrl = `${baseUrl}/api/media/external-videos/${encodeURIComponent(videoId)}/stream`;
      const profile = (await syncCanonicalUser({ db, uid: user.uid, includeContent: false })).profile;
      const video = {
        id: videoId,
        ownerUid: user.uid,
        mediaType,
        title,
        caption,
        description: caption,
        creator: profile.username || `@${String(user.uid).slice(0, 8)}`,
        creatorName: profile.name || "Indo User",
        sourceUrl: url.toString(),
        videoUrl: streamUrl,
        secureUrl: streamUrl,
        streamUrl,
        sourceProvider: new URL(probe.url || url).hostname,
        mimeType: contentType || "video/mp4",
        size: probe.length || 0,
        duration: 0,
        width: 0,
        height: 0,
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        createdAt: Date.now(),
        storage: { provider: "external-url", mode: "link-only" },
        external: { provider: "external-url", sourceUrl: url.toString(), resolvedUrl: probe.url || url.toString(), contentType: contentType || "", acceptRanges: probe.acceptRanges || "" },
      };

      await videoRef.set(video);
      await saveCanonicalVideo({ db, uid: user.uid, video });
      await db.ref(`${canonicalUserRoot(user.uid)}/stats/postsCount`).transaction((current) => (Number(current) || 0) + 1);
      await db.ref(`${canonicalUserRoot(user.uid)}/stats/videosCount`).transaction((current) => (Number(current) || 0) + 1);
      return res.status(201).json({ ok: true, video });
    } catch (error) {
      return res.status(502).json({ ok: false, error: error?.message || "Could not add video link." });
    }
  });

  const streamHandler = async (req, res) => {
    if (!db) return res.status(503).end();
    const videoId = text(req.params.videoId, 200);
    if (!videoId) return res.status(400).end();

    try {
      const snapshot = await db.ref(`videos/${videoId}`).get();
      if (!snapshot.exists()) return res.status(404).end();
      const video = snapshot.val() || {};
      if (String(video.storage?.provider || "").toLowerCase() !== "external-url") return res.status(404).end();
      const source = validSourceUrl(video.external?.resolvedUrl || video.sourceUrl);
      if (!source || isPrivateHostname(source.hostname)) return res.status(404).end();

      const headers = { Accept: "video/*,*/*;q=0.8" };
      const range = String(req.headers.range || "").trim();
      if (range) headers.Range = range;
      const upstream = await fetch(source, { method: "GET", redirect: "follow", headers });
      if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status === 403 ? 502 : upstream.status).end();
      if (!upstream.body) return res.status(502).end();

      const mimeType = String(upstream.headers.get("content-type") || video.mimeType || "video/mp4");
      const length = Number(upstream.headers.get("content-length") || 0);
      const contentRange = String(upstream.headers.get("content-range") || "");
      streamHeaders(res);
      res.set("Content-Type", mimeType);
      if (length > 0) res.set("Content-Length", String(length));
      if (contentRange) res.set("Content-Range", contentRange);
      res.status(upstream.status === 206 ? 206 : 200);
      if (req.method === "HEAD") return res.end();
      upstream.body.pipeTo(new WritableStream({
        write(chunk) { return new Promise((resolve, reject) => res.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve())); },
        close() { res.end(); },
        abort(error) { res.destroy(error); },
      })).catch((error) => { if (!res.headersSent) res.status(502).end(); else res.destroy(error); });
    } catch (error) {
      if (!res.headersSent) return res.status(502).json({ ok: false, error: error?.message || "Could not stream external video." });
      res.destroy(error);
    }
  };

  router.get("/media/external-videos/:videoId/stream", streamHandler);
  router.head("/media/external-videos/:videoId/stream", streamHandler);
  return router;
}
