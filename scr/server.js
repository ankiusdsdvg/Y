const express = require("express");
const cors = require("cors");
const db = require("./db");
const { port, host } = require("./config");
const { searchYouTube, getVideoInfo, getStreamInfo, pipeAudioToMp3 } = require("./youtube");

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use(express.json({ limit: "256kb" }));

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function validId(id) {
  return /^[a-zA-Z0-9_-]{6,20}$/.test(String(id || ""));
}
function videoFromBody(body) {
  const videoId = String(body?.videoId || "").trim();
  if (!validId(videoId)) throw new Error("videoId không hợp lệ");
  return {
    videoId,
    title: String(body.title || videoId).slice(0, 300),
    channel: String(body.channel || "").slice(0, 200),
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  };
}

app.get("/", (req, res) => res.json({
  name: "YouTube API Server", status: "running",
  endpoints: [
    "GET /health", "GET /api/youtube/search?q=...&limit=10",
    "GET /api/youtube/info?id=VIDEO_ID",
    "GET /api/youtube/stream?id=VIDEO_ID&type=audio",
    "GET /api/youtube/audio/VIDEO_ID.mp3",
    "GET /api/youtube/audio/VIDEO_ID.mp3",
    "GET /api/youtube/history?deviceId=esp32",
    "GET /api/youtube/favorites?deviceId=esp32",
    "POST /api/youtube/history", "POST /api/youtube/favorites",
    "DELETE /api/youtube/favorites/VIDEO_ID?deviceId=esp32"
  ]
}));
app.get("/health", (req, res) => res.json({ status: "ok", service: "youtube-audio-api", mode: "audio-only", cookies: false }));

// Audio-only playback: no video extraction, no MJPEG/PCM video pipeline, no cookies.
app.get("/api/youtube/watch", (req, res) => {
  const id = String(req.query.id || "");
  if (!validId(id)) return res.status(400).json({ success: false, error: "id không hợp lệ" });
  res.json({
    success: true, videoId: id, mode: "audio-only",
    audio: `/api/youtube/audio/${encodeURIComponent(id)}.mp3`,
    format: { audio: "MP3", bitrate: "128 kbps" }
  });
});

app.get("/api/youtube/search", asyncRoute(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 20);
  const results = await searchYouTube(q, limit);
  db.saveSearch(req.query.deviceId, q, results);
  res.json({ success: true, query: q, count: results.length, results });
}));

app.get("/api/youtube/info", asyncRoute(async (req, res) => {
  const id = String(req.query.id || "");
  if (!validId(id)) return res.status(400).json({ success: false, error: "id không hợp lệ" });
  res.json({ success: true, video: await getVideoInfo(id) });
}));

app.get("/api/youtube/stream", asyncRoute(async (req, res) => {
  const id = String(req.query.id || "");
  const type = "audio";
  if (!validId(id)) return res.status(400).json({ success: false, error: "id không hợp lệ" });
  res.json({ success: true, ...(await getStreamInfo(id, type)) });
}));

app.get("/api/youtube/audio/:id.mp3", (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "id không hợp lệ" });
  pipeAudioToMp3(req.params.id, req, res);
});

app.get("/api/youtube/history", (req, res) => {
  res.json({ success: true, results: db.history(req.query.deviceId, req.query.limit) });
});
app.post("/api/youtube/history", (req, res) => {
  try {
    const video = videoFromBody(req.body);
    db.savePlay(req.body.deviceId, video);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.get("/api/youtube/favorites", (req, res) => {
  res.json({ success: true, results: db.favorites(req.query.deviceId) });
});
app.post("/api/youtube/favorites", (req, res) => {
  try {
    db.addFavorite(req.body.deviceId, videoFromBody(req.body));
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.delete("/api/youtube/favorites/:id", (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, error: "id không hợp lệ" });
  db.removeFavorite(req.query.deviceId, req.params.id);
  res.json({ success: true });
});

app.use((req, res) => res.status(404).json({ success: false, error: "API không tồn tại" }));
app.use((err, req, res, next) => {
  console.error("[API]", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: err.message || "Internal server error" });
});

app.listen(port, host, () => console.log(`YouTube API listening on http://${host}:${port}`));
