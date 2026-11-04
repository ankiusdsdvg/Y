
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
  let sourceEnded = false;
  let waitingDrain = false;
  let errors = "";

  function addError(data) {
    errors = (errors + data.toString()).slice(-4000);
  }

  function stopProcesses() {
    if (downloader.exitCode === null && !downloader.killed) {
      downloader.kill("SIGKILL");
    }

    if (transcoder.exitCode === null && !transcoder.killed) {
      transcoder.kill("SIGKILL");
    }
  }

  function cleanup() {
    clearInterval(streamBufferTimer);
    clearTimeout(timer);
  }

  function fail() {
    if (finished) return;

    finished = true;
    cleanup();
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

  // =====================================
  // BUFFER FIFO - 120 GIÂY
  // =====================================

  const BITRATE = 128000;

  // 2 phút = 1.920.000 bytes ở 128kbps
  const BUFFER_SECONDS = 120;

  const MAX_BUFFER_BYTES =
    Math.floor((BITRATE / 8) * BUFFER_SECONDS);

  // Gửi 1.600 bytes mỗi 100ms = 128kbps
  const SEND_CHUNK_BYTES = 1600;
  const SEND_INTERVAL_MS = 100;

  const RESUME_BUFFER_BYTES =
    Math.floor(MAX_BUFFER_BYTES * 0.75);

  let audioQueue = [];
  let queueIndex = 0;
  let queueOffset = 0;
  let queuedBytes = 0;

  function startStream() {
    if (started || finished || res.destroyed) return;

    started = true;

    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "none");
  }

  // Thêm dữ liệu vào FIFO
  function addAudio(chunk) {
    if (finished || res.destroyed) return;

    audioQueue.push(Buffer.from(chunk));
    queuedBytes += chunk.length;

    // Đủ 2 phút thì tạm dừng đọc nguồn.
    // Không xóa hoặc bỏ dữ liệu.
    if (queuedBytes >= MAX_BUFFER_BYTES) {
      transcoder.stdout.pause();
    }
  }

  // Lấy dữ liệu FIFO theo đúng thứ tự
  function getAudio(maxBytes) {
    if (queuedBytes <= 0) return null;

    const length = Math.min(maxBytes, queuedBytes);
    const output = Buffer.allocUnsafe(length);

    let written = 0;

    while (written < length) {
      const current = audioQueue[queueIndex];

      const available = current.length - queueOffset;
      const take = Math.min(available, length - written);

      current.copy(
        output,
        written,
        queueOffset,
        queueOffset + take
      );

      written += take;
      queueOffset += take;
      queuedBytes -= take;

      if (queueOffset >= current.length) {
        queueIndex++;
        queueOffset = 0;
      }
    }

    // Dọn mảng đã sử dụng
    if (queueIndex > 100) {
      audioQueue = audioQueue.slice(queueIndex);
      queueIndex = 0;
    }

    // Khi buffer giảm xuống 75%, tiếp tục tải nguồn
    if (
      transcoder.stdout.isPaused() &&
      queuedBytes <= RESUME_BUFFER_BYTES &&
      !sourceEnded
    ) {
      transcoder.stdout.resume();
    }

    return output;
  }

  // Gửi âm thanh theo tốc độ 128kbps
  function flushAudioChunk() {
    if (finished || res.destroyed || !started) return;

    if (waitingDrain) return;

    const chunk = getAudio(SEND_CHUNK_BYTES);

    if (chunk && chunk.length > 0) {
      if (!res.write(chunk)) {
        waitingDrain = true;
      }
    }

    // Nguồn đã kết thúc và FIFO đã phát hết
    if (sourceEnded && queuedBytes === 0) {
      finished = true;
      cleanup();

      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    }
  }

  // =====================================
  // DOWNLOAD + TRANSCODE
  // =====================================

  downloader.stderr.on("data", addError);
  transcoder.stderr.on("data", addError);

  downloader.stdout.pipe(transcoder.stdin);

  downloader.stdout.on("error", addError);
  transcoder.stdin.on("error", addError);

  transcoder.stdout.on("data", chunk => {
    if (finished || res.destroyed) return;

    if (!started) {
      startStream();
    }

    addAudio(chunk);
  });

  // Bắt đầu gửi ngay khi có dữ liệu đầu tiên.
  // Không đợi đủ 2 phút.
  const streamBufferTimer = setInterval(() => {
    flushAudioChunk();
  }, SEND_INTERVAL_MS);

  // Nếu socket sẵn sàng gửi tiếp
  res.on("drain", () => {
    waitingDrain = false;
  });

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

  transcoder.on("close", code => {
    if (finished) return;

    if (code !== 0) {
      addError("\nFFmpeg exit code: " + code);
      fail();
      return;
    }

    sourceEnded = true;

    if (!started) {
      fail();
      return;
    }

    // Nếu FIFO đã hết thì kết thúc ngay
    if (queuedBytes === 0) {
      finished = true;
      cleanup();

      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    }
  });

  // Timeout 10 phút như code ban đầu
  const timer = setTimeout(() => {
    addError("\nStream timeout");
    fail();
  }, 10 * 60 * 1000);

  res.on("close", () => {
    if (!res.writableEnded) {
      finished = true;
      cleanup();
      stopProcesses();
    }
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log("SoundCloud API listening on port " + PORT);
});
