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

// MP3 128 kbps = approximately 16 KB/s
const STREAM_BITRATE = 128000;
const STREAM_BYTES_PER_SECOND = STREAM_BITRATE / 8;

// Send approximately 250 ms of audio per interval
const STREAM_INTERVAL = 250;
const STREAM_CHUNK_BYTES = Math.round(
  STREAM_BYTES_PER_SECOND * STREAM_INTERVAL / 1000
);

// Buffer approximately 4 seconds
const STREAM_MAX_BUFFER = STREAM_BYTES_PER_SECOND * 4;

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
  }, TIMEOUT);

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
    version: "3.0",
    success: true,
    cookiesRequired: false,
    streaming: "SoundCloud AAC -> MP3 128kbps CBR",
    sampleRate: 44100,
    channels: 2,
    bitrate: 128000,
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
    service: "SoundCloud Audio API"
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
// STREAM
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

    transcoder = spawn(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel", "error",

        "-i", "pipe:0",

        "-map", "0:a:0",
        "-vn",

        "-ac", "2",
        "-ar", "44100",

        "-c:a", "libmp3lame",
        "-b:a", "128k",
        "-minrate", "128k",
        "-maxrate", "128k",
        "-bufsize", "256k",

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
      error: "Không khởi chạy được tiến trình phát nhạc.",
      detail: err.message
    });
  }

  let finished = false;
  let headersSent = false;
  let streamEnded = false;
  let waitingDrain = false;
  let pendingAudio = Buffer.alloc(0);
  let errors = "";

  let lastFlush = Date.now();
  let totalBytes = 0;

  function addError(data) {
    errors = (errors + data.toString()).slice(-4000);
  }

  function stopProcesses() {
    if (downloader && downloader.exitCode === null) {
      downloader.kill("SIGKILL");
    }

    if (transcoder && transcoder.exitCode === null) {
      transcoder.kill("SIGKILL");
    }
  }

  function fail() {
    if (finished) return;

    finished = true;
    clearInterval(streamTimer);
    clearTimeout(timeoutTimer);

    stopProcesses();

    if (!headersSent && !res.destroyed) {
      res.status(502).json({
        success: false,
        error: "Không phát được track này.",
        detail: errors.slice(-1200)
      });
    } else if (!res.destroyed && !res.writableEnded) {
      res.end();
    }
  }

  function beginResponse() {
    if (headersSent) return;

    headersSent = true;

    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Accept-Ranges", "none");
    res.setHeader("Transfer-Encoding", "chunked");
  }

  // ===================================
  // CONTROLLED AUDIO OUTPUT
  // ===================================

  function flushAudio() {
    if (
      finished ||
      res.destroyed ||
      waitingDrain ||
      pendingAudio.length === 0
    ) {
      return;
    }

    beginResponse();

    const chunk = pendingAudio.subarray(
      0,
      Math.min(STREAM_CHUNK_BYTES, pendingAudio.length)
    );

    pendingAudio = pendingAudio.subarray(chunk.length);

    totalBytes += chunk.length;

    const canContinue = res.write(chunk);

    lastFlush = Date.now();

    if (!canContinue) {
      waitingDrain = true;

      res.once("drain", () => {
        waitingDrain = false;
        flushAudio();
      });
    }
  }

  // ===================================
  // RECEIVE FFMPEG AUDIO
  // ===================================

  transcoder.stdout.on("data", chunk => {
    if (finished || res.destroyed) return;

    // Backpressure: do not discard audio.
    const next = Buffer.from(chunk);

    pendingAudio = pendingAudio.length
      ? Buffer.concat([pendingAudio, next])
      : next;

    if (pendingAudio.length > STREAM_MAX_BUFFER * 2) {
      addError("\nAudio buffer exceeded expected size.");
      transcoder.stdout.pause();
    }
  });

  // ===================================
  // STREAM PACER
  // ===================================

  const streamTimer = setInterval(() => {
    if (finished || res.destroyed) return;

    flushAudio();

    if (
      pendingAudio.length < STREAM_MAX_BUFFER &&
      !waitingDrain
    ) {
      transcoder.stdout.resume();
    }
  }, STREAM_INTERVAL);

  // ===================================
  // PIPE DOWNLOADER TO FFMPEG
  // ===================================

  downloader.stdout.pipe(transcoder.stdin);

  downloader.stderr.on("data", addError);
  transcoder.stderr.on("data", addError);

  downloader.stdout.on("error", err => {
    addError(err);
    fail();
  });

  transcoder.stdin.on("error", err => {
    if (!finished) {
      addError(err);
      fail();
    }
  });

  downloader.on("error", err => {
    addError(err);
    fail();
  });

  transcoder.on("error", err => {
    addError(err);
    fail();
  });

  // ===================================
  // DOWNLOADER FINISHED
  // ===================================

  downloader.on("close", code => {
    if (code !== 0 && !finished) {
      addError("\nyt-dlp exit code: " + code);
      fail();
    }
  });

  // ===================================
  // FFMPEG FINISHED
  // ===================================

  transcoder.on("close", code => {
    if (finished) return;

    if (code !== 0) {
      addError("\nFFmpeg exit code: " + code);
      fail();
      return;
    }

    streamEnded = true;
  });

  // ===================================
  // FINISH AFTER ALL AUDIO IS SENT
  // ===================================

  function finishIfEmpty() {
    if (
      streamEnded &&
      pendingAudio.length === 0 &&
      !waitingDrain &&
      !finished
    ) {
      finished = true;

      clearInterval(streamTimer);
      clearTimeout(timeoutTimer);

      if (!res.destroyed && !res.writableEnded) {
        if (!headersSent) {
          beginResponse();
        }

        res.end();
      }
    }
  }

  const finishTimer = setInterval(() => {
    if (finished || res.destroyed) return;

    flushAudio();
    finishIfEmpty();
  }, 20);

  // ===================================
  // TIMEOUT
  // ===================================

  const timeoutTimer = setTimeout(() => {
    addError("\nStream timeout");
    fail();
  }, 10 * 60 * 1000);

  // ===================================
  // CLIENT DISCONNECTED
  // ===================================

  res.on("close", () => {
    clearInterval(streamTimer);
    clearInterval(finishTimer);
    clearTimeout(timeoutTimer);

    if (!res.writableEnded) {
      finished = true;
      stopProcesses();
    }
  });
});

// =====================================
// START SERVER
// =====================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "SoundCloud API listening on port " + PORT
  );

  console.log("Audio: MP3 128kbps / 44100Hz / Stereo");
});
