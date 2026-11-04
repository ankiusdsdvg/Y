
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

const MAX_OUTPUT = 20 * 1024 * 1024;
const TIMEOUT = 45000;

function validTrackUrl(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      (u.hostname === "soundcloud.com" ||
       u.hostname.endsWith(".soundcloud.com")) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

// Run yt-dlp and receive JSON
function runJson(args, res, transform = data => data) {
  const child = spawn(YTDLP, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let finished = false;

  const timer = setTimeout(() => {
    stderr += "\nProcess timeout";
    child.kill("SIGKILL");
  }, TIMEOUT);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", chunk => {
    stdout += chunk;

    if (stdout.length > MAX_OUTPUT) {
      child.kill("SIGKILL");
    }
  });

  child.stderr.on("data", chunk => {
    stderr = (stderr + chunk).slice(-4000);
  });

  child.on("error", err => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: "Không chạy được yt-dlp.",
        detail: err.message
      });
    }
  });

  child.on("close", code => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);

    if (res.headersSent || res.destroyed) return;

    if (code !== 0) {
      return res.status(502).json({
        success: false,
        error: "SoundCloud không trả được dữ liệu.",
        detail: stderr.slice(-1200)
      });
    }

    try {
      const data = JSON.parse(stdout);
      res.json(transform(data));
    } catch (err) {
      res.status(502).json({
        success: false,
        error: "Không đọc được dữ liệu SoundCloud.",
        detail: err.message
      });
    }
  });

  res.on("close", () => {
    if (!finished) child.kill("SIGKILL");
  });
}

// Normalize search results
function normalizeTrack(x) {
  const page = x.webpage_url ||
    (typeof x.url === "string" && x.url.startsWith("https://soundcloud.com/")
      ? x.url : null);

  return {
    id: x.id || null,
    title: x.title || "Unknown",
    artist: x.uploader || x.artist || x.creator || null,
    duration: x.duration || null,
    thumbnail: x.thumbnail || null,
    url: page,
    webpage_url: page
  };
}

// Home
app.get("/", (_req, res) => {
  res.json({
    name: "SoundCloud Audio API",
    version: "2.0",
    success: true,
    cookiesRequired: false,
    streaming: "AAC HLS -> MP3 128kbps",
    endpoints: [
      "/health",
      "/api/soundcloud/search?q=lofi",
      "/api/soundcloud/resolve?url=SOUNDCLOUD_TRACK_URL",
      "/api/soundcloud/stream?url=SOUNDCLOUD_TRACK_URL"
    ]
  });
});

// Health
app.get("/health", (_req, res) => {
  res.json({
    success: true,
    service: "SoundCloud Audio API"
  });
});

// Search
app.get("/api/soundcloud/search", (req, res) => {
  const q = String(req.query.q || "").trim();

  const limit = Math.min(
    Math.max(parseInt(req.query.limit || "10", 10) || 10, 1),
    25
  );

  if (!q) {
    return res.status(400).json({
      success: false,
      error: "Thiếu từ khóa q."
    });
  }

  runJson(
    [
      "--dump-single-json",
      "--flat-playlist",
      "--no-warnings",
      "--no-check-formats",
      `scsearch${limit}:${q}`
    ],
    res,
    data => {
      const entries = (data.entries || [])
        .filter(Boolean)
        .map(normalizeTrack)
        .filter(x => x.webpage_url);

      return {
        success: true,
        source: "SoundCloud",
        count: entries.length,
        results: entries
      };
    }
  );
});

// Resolve track
app.get("/api/soundcloud/resolve", (req, res) => {
  const url = String(req.query.url || "");

  if (!validTrackUrl(url)) {
    return res.status(400).json({
      success: false,
      error: "URL SoundCloud không hợp lệ."
    });
  }

  runJson(
    [
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--no-check-formats",
      url
    ],
    res,
    d => ({
      success: true,
      id: d.id || null,
      title: d.title || "Unknown",
      artist: d.uploader || d.artist || null,
      duration: d.duration || null,
      thumbnail: d.thumbnail || null,
      webpage_url: d.webpage_url || url,
      stream_url:
        "/api/soundcloud/stream?url=" +
        encodeURIComponent(d.webpage_url || url),
      cookiesRequired: false,
      audioFormat: "AAC HLS",
      outputFormat: "MP3 128kbps"
    })
  );
});

// Stream MP3 from SoundCloud AAC HLS
app.get("/api/soundcloud/stream", (req, res) => {
  const url = String(req.query.url || "");

  if (!validTrackUrl(url)) {
    return res.status(400).json({
      success: false,
      error: "URL SoundCloud không hợp lệ."
    });
  }

  const downloader = spawn(
    YTDLP,
    [
      "--no-warnings",
      "--no-playlist",
      "--no-part",
      "--retries", "2",
      "--fragment-retries", "2",
      "--socket-timeout", "20",
      "-f", "bestaudio/best",
      "-o", "-",
      url
    ],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const transcoder = spawn(
    FFMPEG,
    [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-map", "0:a:0",
      "-vn",
      "-ac", "2",
      "-ar", "44100",
      "-b:a", "128k",
      "-f", "mp3",
      "pipe:1"
    ],
    {
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  let started = false;
  let finished = false;
  let errors = "";

  function addError(data) {
    errors = (errors + data.toString()).slice(-4000);
  }

  function stopProcesses() {
    if (downloader.exitCode === null) {
      downloader.kill("SIGKILL");
    }

    if (transcoder.exitCode === null) {
      transcoder.kill("SIGKILL");
    }
  }

  function fail() {
    if (finished) return;
    finished = true;
    clearInterval(streamBufferTimer);

    stopProcesses();

    if (!started && !res.headersSent && !res.destroyed) {
      res.status(502).json({
        success: false,
        error: "Không phát được track này.",
        detail: errors.slice(-1200)
      });
    } else if (!res.destroyed && !res.writableEnded) {
      res.end();
    }
  }

  downloader.stderr.on("data", addError);
  transcoder.stderr.on("data", addError);

  downloader.stdout.pipe(transcoder.stdin);

  downloader.stdout.on("error", addError);
  transcoder.stdin.on("error", addError);

  // MP3 128 kbps ~= 16 KB/s. We keep a small safety cushion above that so the ESP
  // sees a steady stream without trying to read the whole buffer in a burst and then stalling.
  // Too fast => fast-forward / gaps. Too slow => underflow. The rate below is about 32 KB/s.
  const STREAM_CHUNK_BYTES = 8 * 1024;
  const STREAM_FLUSH_MS = 200;
  const STREAM_MAX_BUFFER_BYTES = 96 * 1024; // roughly 3s of headroom at 128 kbps
  let pendingAudio = Buffer.alloc(0);

  function flushAudioChunk() {
    if (finished || res.destroyed || pendingAudio.length === 0) return;

    if (!started) {
      started = true;
      res.status(200);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Accept-Ranges", "none");
    }

    const toWrite = pendingAudio.subarray(0, Math.min(STREAM_CHUNK_BYTES, pendingAudio.length));
    pendingAudio = pendingAudio.subarray(toWrite.length);

    if (!res.write(toWrite)) {
      transcoder.stdout.pause();
      res.once("drain", () => {
        transcoder.stdout.resume();
      });
    }
  }

  transcoder.stdout.on("data", chunk => {
    if (finished || res.destroyed) return;

    const nextChunk = Buffer.from(chunk);
    const merged = Buffer.concat([pendingAudio, nextChunk]);
    if (merged.length > STREAM_MAX_BUFFER_BYTES) {
      // Never clear the whole queue: that would drop the current playback position and create the
      // jump-from-5s-to-15s symptom. Keep the newest tail of the stream instead and discard only stale data.
      const excess = merged.length - STREAM_MAX_BUFFER_BYTES;
      pendingAudio = merged.subarray(excess);
      addError("\nStream buffer overflow, trimming stale audio");
      return;
    }

    pendingAudio = merged;
  });

  const streamBufferTimer = setInterval(() => {
    if (!finished && !res.destroyed) {
      flushAudioChunk();
    }
  }, STREAM_FLUSH_MS);

  downloader.on("error", err => {
    addError(err);
    fail();
  });

  transcoder.on("error", err => {
    addError(err);
    fail();
  });

  downloader.on("close", code => {
    if (code !== 0 && !finished) {
      addError("\nyt-dlp exit code: " + code);
      fail();
    }
  });

  const timer = setTimeout(() => {
    addError("\nStream timeout");
    fail();
  }, 10 * 60 * 1000);

  res.on("close", () => {
    clearTimeout(timer);
    clearInterval(streamBufferTimer);

    if (!res.writableEnded) {
      finished = true;
      stopProcesses();
    }
  });

  transcoder.on("close", code => {
    clearInterval(streamBufferTimer);
    if (finished) return;

    if (code !== 0) {
      addError("\nFFmpeg exit code: " + code);
      fail();
      return;
    }

    finished = true;

    while (pendingAudio.length > 0) {
      flushAudioChunk();
      if (pendingAudio.length > 0) {
        break;
      }
    }

    if (!res.destroyed && !res.writableEnded) {
      res.end();
    }
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log("SoundCloud API listening on port " + PORT);
});
