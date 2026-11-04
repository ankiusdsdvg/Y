const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const { PassThrough } = require("stream");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// =====================================
// CONFIG
// =====================================

const MAX_OUTPUT = 20 * 1024 * 1024;
const JSON_TIMEOUT = 45000;
const STREAM_TIMEOUT = 10 * 60 * 1000;

// RAM buffer per stream
const BUFFER_SIZE = 1024 * 1024; // 1 MB
const PREBUFFER_SIZE = 256 * 1024; // 256 KB

// Audio
const AUDIO_BITRATE = "128k";
const AUDIO_RATE = 44100;
const AUDIO_CHANNELS = 2;

// =====================================
// VALIDATE URL
// =====================================

function validTrackUrl(value) {
  try {
    const u = new URL(value);

    return (
      u.protocol === "https:" &&
      (
        u.hostname === "soundcloud.com" ||
        u.hostname.endsWith(".soundcloud.com")
      ) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

// =====================================
// RUN YT-DLP JSON
// =====================================

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
  }, JSON_TIMEOUT);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", chunk => {
    stdout += chunk;

    if (stdout.length > MAX_OUTPUT) {
      stderr += "\nOutput too large";
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

    if (!res.headersSent && !res.destroyed) {
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

    if (res.destroyed || res.headersSent) return;

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
    if (!finished) {
      child.kill("SIGKILL");
    }
  });
}

// =====================================
// NORMALIZE TRACK
// =====================================

function normalizeTrack(x) {
  const page =
    x.webpage_url ||
    (
      typeof x.url === "string" &&
      x.url.startsWith("https://soundcloud.com/")
        ? x.url
        : null
    );

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

// =====================================
// HOME
// =====================================

app.get("/", (_req, res) => {
  res.json({
    name: "SoundCloud Audio API",
    version: "4.0",
    success: true,
    cookiesRequired: false,

    streaming: "AAC -> MP3 CBR 128kbps",

    audio: {
      format: "MP3",
      bitrate: 128000,
      sampleRate: AUDIO_RATE,
      channels: AUDIO_CHANNELS
    },

    buffer: {
      enabled: true,
      size: BUFFER_SIZE,
      prebuffer: PREBUFFER_SIZE,
      type: "RAM"
    },

    endpoints: [
      "/health",
      "/api/soundcloud/search?q=lofi",
      "/api/soundcloud/resolve?url=SOUNDCLOUD_TRACK_URL",
      "/api/soundcloud/stream?url=SOUNDCLOUD_TRACK_URL"
    ]
  });
});

// =====================================
// HEALTH
// =====================================

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    service: "SoundCloud Audio API",
    buffer: "enabled"
  });
});

// =====================================
// SEARCH
// =====================================

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

// =====================================
// RESOLVE
// =====================================

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
      outputFormat: "MP3 CBR 128kbps"
    })
  );
});

// =====================================
// STREAM WITH RAM PREBUFFER
// =====================================

app.get("/api/soundcloud/stream", (req, res) => {
  const url = String(req.query.url || "");

  if (!validTrackUrl(url)) {
    return res.status(400).json({
      success: false,
      error: "URL SoundCloud không hợp lệ."
    });
  }

  let downloader;
  let transcoder;

  try {
    // Download SoundCloud audio
    downloader = spawn(
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

    // Convert to MP3
    transcoder = spawn(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel", "error",

        "-i", "pipe:0",

        "-map", "0:a:0",
        "-vn",

        "-ac", String(AUDIO_CHANNELS),
        "-ar", String(AUDIO_RATE),

        "-c:a", "libmp3lame",
        "-b:a", AUDIO_BITRATE,

        "-write_xing", "0",
        "-id3v2_version", "0",

        "-f", "mp3",
        "pipe:1"
      ],
      {
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Không khởi chạy được FFmpeg hoặc yt-dlp.",
      detail: err.message
    });
  }

  let started = false;
  let finished = false;
  let errors = "";

  // ===================================
  // RAM BUFFER
  // ===================================

  const audioBuffer = new PassThrough({
    highWaterMark: BUFFER_SIZE
  });

  // ===================================
  // ERROR LOG
  // ===================================

  function addError(data) {
    errors = (errors + data.toString()).slice(-4000);
  }

  // ===================================
  // CLEANUP
  // ===================================

  function stopProcesses() {
    if (downloader && downloader.exitCode === null) {
      downloader.kill("SIGKILL");
    }

    if (transcoder && transcoder.exitCode === null) {
      transcoder.kill("SIGKILL");
    }
  }

  function cleanup() {
    clearTimeout(timeoutTimer);

    downloader.stdout.unpipe(transcoder.stdin);
    transcoder.stdout.unpipe(audioBuffer);

    stopProcesses();
  }

  // ===================================
  // ERROR HANDLER
  // ===================================

  function fail() {
    if (finished) return;

    finished = true;

    cleanup();

    audioBuffer.destroy();

    if (!res.headersSent && !res.destroyed) {
      res.status(502).json({
        success: false,
        error: "Không phát được track này.",
        detail: errors.slice(-1200)
      });
    } else if (!res.destroyed && !res.writableEnded) {
      res.destroy();
    }
  }

  // ===================================
  // START HTTP STREAM
  // ===================================

  function startStream() {
    if (started || finished || res.destroyed) return;

    started = true;

    res.status(200);

    res.setHeader("Content-Type", "audio/mpeg");

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate"
    );

    res.setHeader("Accept-Ranges", "none");

    // Pipe preserves backpressure automatically.
    audioBuffer.pipe(res);
  }

  // ===================================
  // PREBUFFER CHECK
  // ===================================

  audioBuffer.on("readable", () => {
    if (started || finished) return;

    // Wait until RAM buffer has enough MP3 data.
    if (audioBuffer.readableLength >= PREBUFFER_SIZE) {
      startStream();
    }
  });

  // If track is shorter than prebuffer threshold,
  // start when FFmpeg finishes producing data.
  audioBuffer.on("finish", () => {
    if (!started && !finished) {
      startStream();
    }
  });

  // ===================================
  // PIPE AUDIO TO RAM
  // ===================================

  transcoder.stdout.pipe(audioBuffer);

  // ===================================
  // DOWNLOAD -> FFMPEG
  // ===================================

  downloader.stdout.pipe(transcoder.stdin);

  downloader.stderr.on("data", addError);
  transcoder.stderr.on("data", addError);

  // ===================================
  // PROCESS ERRORS
  // ===================================

  downloader.on("error", err => {
    addError(err);
    fail();
  });

  transcoder.on("error", err => {
    addError(err);
    fail();
  });

  audioBuffer.on("error", err => {
    addError(err);
    fail();
  });

  downloader.stdout.on("error", err => {
    addError(err);
    fail();
  });

  transcoder.stdout.on("error", err => {
    addError(err);
    fail();
  });

  // ===================================
  // DOWNLOADER CLOSE
  // ===================================

  downloader.on("close", code => {
    if (code !== 0 && !finished) {
      addError("\nyt-dlp exit code: " + code);
      fail();
    }
  });

  // ===================================
  // FFMPEG CLOSE
  // ===================================

  transcoder.on("close", code => {
    if (finished) return;

    if (code !== 0) {
      addError("\nFFmpeg exit code: " + code);
      fail();
      return;
    }

    // Signal that no more audio will be written.
    audioBuffer.end();
  });

  // ===================================
  // TIMEOUT
  // ===================================

  const timeoutTimer = setTimeout(() => {
    addError("\nStream timeout");
    fail();
  }, STREAM_TIMEOUT);

  // ===================================
  // CLIENT DISCONNECTED
  // ===================================

  res.on("close", () => {
    if (!res.writableEnded) {
      finished = true;
      cleanup();
      audioBuffer.destroy();
    }
  });

  // ===================================
  // STREAM COMPLETE
  // ===================================

  res.on("finish", () => {
    finished = true;
    clearTimeout(timeoutTimer);
  });
});

// =====================================
// START SERVER
// =====================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("SoundCloud API v4.0 started");

  console.log("Port:", PORT);
  console.log("Format: MP3 CBR 128kbps");
  console.log("Sample rate:", AUDIO_RATE);
  console.log("Channels:", AUDIO_CHANNELS);
  console.log("RAM buffer:", BUFFER_SIZE);
  console.log("Prebuffer:", PREBUFFER_SIZE);
});
