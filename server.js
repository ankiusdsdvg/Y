const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function runJson(args, res) {
  const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (stdout.length > 20 * 1024 * 1024) child.kill("SIGKILL");
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", err => {
    if (!res.headersSent) res.status(500).json({ success: false, error: `Không chạy được yt-dlp: ${err.message}` });
  });
  child.on("close", code => {
    if (res.headersSent) return;
    if (code !== 0) return res.status(502).json({ success: false, error: "SoundCloud không trả được dữ liệu công khai.", detail: stderr.slice(-1200) });
    try { res.json(JSON.parse(stdout)); }
    catch { res.status(502).json({ success: false, error: "Dữ liệu từ SoundCloud không hợp lệ." }); }
  });
}

function validTrackUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && (u.hostname === "soundcloud.com" || u.hostname.endsWith(".soundcloud.com"));
  } catch { return false; }
}

app.get("/", (_req, res) => res.json({
  name: "SoundCloud Audio API",
  success: true,
  cookiesRequired: false,
  endpoints: ["/api/soundcloud/search?q=lofi", "/api/soundcloud/resolve?url=SOUNDCLOUD_TRACK_URL", "/api/soundcloud/stream?url=SOUNDCLOUD_TRACK_URL"]
}));

app.get("/health", (_req, res) => res.json({ success: true }));

// Search public SoundCloud tracks. yt-dlp uses SoundCloud's public search extractor.
app.get("/api/soundcloud/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10) || 10, 1), 25);
  if (!q) return res.status(400).json({ success: false, error: "Thiếu từ khóa q." });
  runJson(["--dump-single-json", "--flat-playlist", "--no-warnings", `scsearch${limit}:${q}`], {
    ...res,
    json: data => {
      const entries = (data.entries || []).filter(Boolean).map(x => ({
        id: x.id || null,
        title: x.title || "Unknown",
        artist: x.uploader || x.artist || null,
        duration: x.duration || null,
        thumbnail: x.thumbnail || null,
        url: x.url && String(x.url).startsWith("http") ? x.url : (x.webpage_url || null),
        webpage_url: x.webpage_url || null
      }));
      res.json({ success: true, source: "SoundCloud", count: entries.length, results: entries });
    }
  });
});

// Resolve public track metadata and the best available audio format URL.
app.get("/api/soundcloud/resolve", (req, res) => {
  const url = String(req.query.url || "");
  if (!validTrackUrl(url)) return res.status(400).json({ success: false, error: "URL SoundCloud không hợp lệ." });
  const child = spawn(YTDLP, ["-J", "--no-warnings", "--no-playlist", url], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", d => out += d);
  child.stderr.on("data", d => err += d);
  child.on("error", e => res.status(500).json({ success: false, error: e.message }));
  child.on("close", code => {
    if (res.headersSent) return;
    if (code !== 0) return res.status(502).json({ success: false, error: "Không lấy được track công khai.", detail: err.slice(-1000) });
    try {
      const d = JSON.parse(out);
      res.json({ success: true, id: d.id, title: d.title, artist: d.uploader || d.artist || null,
        duration: d.duration || null, thumbnail: d.thumbnail || null,
        webpage_url: d.webpage_url || url, stream_url: `/api/soundcloud/stream?url=${encodeURIComponent(d.webpage_url || url)}`,
        cookiesRequired: false });
    } catch { res.status(502).json({ success: false, error: "Không đọc được metadata." }); }
  });
});

// Stream audio transcoded to MP3. The stream is piped; it is not saved on the server.
app.get("/api/soundcloud/stream", (req, res) => {
  const url = String(req.query.url || "");
  if (!validTrackUrl(url)) return res.status(400).json({ success: false, error: "URL SoundCloud không hợp lệ." });

  const downloader = spawn(YTDLP, ["-f", "bestaudio/best", "--no-warnings", "--no-playlist", "-o", "-", url],
    { stdio: ["ignore", "pipe", "pipe"] });
  const transcoder = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0",
    "-vn", "-ac", "2", "-ar", "44100", "-b:a", "128k", "-f", "mp3", "pipe:1"],
    { stdio: ["pipe", "pipe", "pipe"] });

  let started = false;
  let errors = "";
  downloader.stdout.pipe(transcoder.stdin);
  downloader.stderr.on("data", d => errors += d.toString());
  transcoder.stderr.on("data", d => errors += d.toString());
  transcoder.stdout.on("data", chunk => {
    if (!started) {
      started = true;
      res.status(200);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Transfer-Encoding", "chunked");
    }
    res.write(chunk);
  });
  const fail = () => {
    if (!started && !res.headersSent) res.status(502).json({ success: false, error: "Không phát được track này.", detail: errors.slice(-1000) });
    else if (!res.writableEnded) res.end();
  };
  downloader.on("error", fail);
  transcoder.on("error", fail);
  downloader.on("close", code => { if (code !== 0) fail(); });
  transcoder.on("close", code => { if (code !== 0) fail(); else if (!res.writableEnded) res.end(); });
  req.on("close", () => { downloader.kill("SIGKILL"); transcoder.kill("SIGKILL"); });
});

app.listen(PORT, "0.0.0.0", () => console.log(`SoundCloud API listening on ${PORT}`));
