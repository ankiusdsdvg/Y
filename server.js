

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

const BUFFER_DIR = process.env.BUFFER_DIR ||
    path.join(os.tmpdir(), "soundcloud-buffer");

const MAX_OUTPUT = 20 * 1024 * 1024;
const sessions = new Map();

fs.mkdirSync(BUFFER_DIR, { recursive: true });

function validTrackUrl(value) {
    try {
        const u = new URL(value);

        return u.protocol === "https:" &&
            (u.hostname === "soundcloud.com" ||
             u.hostname.endsWith(".soundcloud.com")) &&
            !u.username && !u.password;
    } catch {
        return false;
    }
}

// ========================================
// YT-DLP JSON
// ========================================

function runJson(args, res, transform = x => x) {
    const child = spawn(YTDLP, args, {
        stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
        child.kill("SIGKILL");
    }, 60000);

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
                error: err.message
            });
        }
    });

    child.on("close", code => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        if (res.destroyed) return;

        if (code !== 0) {
            return res.status(502).json({
                success: false,
                error: "yt-dlp failed",
                detail: stderr.slice(-1200)
            });
        }

        try {
            res.json(transform(JSON.parse(stdout)));
        } catch (e) {
            res.status(502).json({
                success: false,
                error: e.message
            });
        }
    });

    res.on("close", () => {
        if (!finished) child.kill("SIGKILL");
    });
}

function normalizeTrack(x) {
    const url = x.webpage_url ||
        (typeof x.url === "string" &&
         x.url.startsWith("https://soundcloud.com/")
            ? x.url : null);

    return {
        id: x.id || null,
        title: x.title || "Unknown",
        artist: x.uploader || x.artist || x.creator || null,
        duration: x.duration || null,
        thumbnail: x.thumbnail || null,
        url
    };
}

// ========================================
// HOME
// ========================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        server: "SoundCloud FIFO Streaming",
        version: "3.0",
        format: "MP3 128kbps",
        buffer: "Disk FIFO",
        endpoints: [
            "/api/soundcloud/search?q=lofi",
            "/api/soundcloud/resolve?url=TRACK",
            "/stream?url=TRACK&id=esp32",
            "/stream?id=esp32",
            "/pause",
            "/resume",
            "/status?id=esp32",
            "/stop"
        ]
    });
});

app.get("/health", (req, res) => {
    res.json({ success: true });
});

// ========================================
// SEARCH
// ========================================

app.get("/api/soundcloud/search", (req, res) => {
    const q = String(req.query.q || "").trim();

    const limit = Math.min(
        Math.max(parseInt(req.query.limit || "10", 10) || 10, 1),
        25
    );

    if (!q) {
        return res.status(400).json({
            success: false,
            error: "Missing q"
        });
    }

    runJson([
        "--dump-single-json",
        "--flat-playlist",
        "--no-warnings",
        "--no-check-formats",
        `scsearch${limit}:${q}`
    ], res, data => {
        const results = (data.entries || [])
            .filter(Boolean)
            .map(normalizeTrack)
            .filter(x => x.url);

        return {
            success: true,
            source: "SoundCloud",
            count: results.length,
            results
        };
    });
});

// ========================================
// RESOLVE
// ========================================

app.get("/api/soundcloud/resolve", (req, res) => {
    const url = String(req.query.url || "");

    if (!validTrackUrl(url)) {
        return res.status(400).json({
            success: false,
            error: "Invalid SoundCloud URL"
        });
    }

    runJson([
        "--dump-single-json",
        "--no-warnings",
        "--no-playlist",
        "--no-check-formats",
        url
    ], res, d => ({
        success: true,
        id: d.id,
        title: d.title,
        artist: d.uploader || d.artist,
        duration: d.duration,
        thumbnail: d.thumbnail,
        url: d.webpage_url || url,
        stream: "/stream?id=esp32",
        outputFormat: "MP3 128kbps"
    }));
});

// ========================================
// PROCESS CONTROL
// ========================================

function killProcess(proc) {
    if (proc && proc.exitCode === null && !proc.killed) {
        proc.kill("SIGKILL");
    }
}

// ========================================
// CREATE PRODUCER
// ========================================

function createSession(id, url) {
    const file = path.join(
        BUFFER_DIR,
        crypto.randomUUID() + ".mp3"
    );

    const session = {
        id,
        url,
        file,

        offset: 0,
        size: 0,

        paused: false,
        producerDone: false,
        stopped: false,
        error: null,

        downloader: null,
        transcoder: null,
        writer: null,

        consumer: null
    };

    sessions.set(id, session);

    // File buffer
    const writer = fs.createWriteStream(file, {
        flags: "wx"
    });

    session.writer = writer;

    // Download SoundCloud
    const downloader = spawn(YTDLP, [
        "--no-warnings",
        "--no-playlist",
        "--no-part",
        "--retries", "3",
        "--fragment-retries", "3",
        "--socket-timeout", "30",
        "-f", "bestaudio/best",
        "-o", "-",
        url
    ], {
        stdio: ["ignore", "pipe", "pipe"]
    });

    session.downloader = downloader;

    // AAC/HLS -> MP3
    const transcoder = spawn(FFMPEG, [
        "-hide_banner",
        "-loglevel", "error",

        "-i", "pipe:0",

        "-map", "0:a:0",
        "-vn",

        "-ac", "2",
        "-ar", "44100",
        "-b:a", "128k",

        "-flush_packets", "1",
        "-f", "mp3",

        "pipe:1"
    ], {
        stdio: ["pipe", "pipe", "pipe"]
    });

    session.transcoder = transcoder;

    function fail(error) {
        if (session.stopped || session.producerDone) return;

        session.error = String(error).slice(0, 2000);

        killProcess(downloader);
        killProcess(transcoder);

        if (!writer.destroyed) writer.end();
    }

    downloader.stderr.on("data", d => {
        if (session.error) {
            session.error = (session.error + d.toString()).slice(-4000);
        }
    });

    transcoder.stderr.on("data", d => {
        session.error = (session.error || "") + d.toString();
        session.error = session.error.slice(-4000);
    });

    downloader.stdout.pipe(transcoder.stdin);

    transcoder.stdout.pipe(writer);

    downloader.on("error", fail);
    transcoder.on("error", fail);

    writer.on("error", fail);

    writer.on("finish", () => {
        session.producerDone = true;
        session.size = fs.existsSync(file)
            ? fs.statSync(file).size
            : session.size;

        pump(session);
    });

    writer.on("close", () => {
        if (!session.producerDone && !session.stopped) {
            session.producerDone = true;
            pump(session);
        }
    });

    downloader.on("close", code => {
        if (code !== 0 && !session.stopped &&
            !session.producerDone) {
            fail("yt-dlp exit code " + code);
        }
    });

    transcoder.on("close", code => {
        if (code !== 0 && !session.stopped &&
            !session.producerDone) {
            fail("FFmpeg exit code " + code);
        }
    });

    // Track actual file size
    const sizeTimer = setInterval(() => {
        if (session.stopped) {
            clearInterval(sizeTimer);
            return;
        }

        try {
            session.size = fs.statSync(file).size;
        } catch {}

    }, 250);

    writer.on("finish", () => clearInterval(sizeTimer));

    return session;
}

// ========================================
// FIFO CONSUMER
// ========================================

function pump(session) {
    const c = session.consumer;

    if (!c || c.closed || session.paused ||
        session.stopped || c.reader) {
        return;
    }

    if (c.timer) {
        clearTimeout(c.timer);
        c.timer = null;
    }

    if (session.size <= session.offset) {
        if (session.producerDone) {
            c.res.end();
            return;
        }

        c.timer = setTimeout(() => pump(session), 100);
        return;
    }

    const reader = fs.createReadStream(session.file, {
        start: session.offset
    });

    c.reader = reader;

    reader.on("data", chunk => {
        if (c.closed || session.paused ||
            session.stopped) {
            reader.pause();
            return;
        }

        // Update position only for bytes accepted by HTTP.
        const ok = c.res.write(chunk);
        session.offset += chunk.length;

        if (!ok) {
            reader.pause();

            c.res.once("drain", () => {
                if (!c.closed && !session.paused &&
                    !session.stopped) {
                    reader.resume();
                }
            });
        }
    });

    reader.on("end", () => {
        if (c.reader === reader) {
            c.reader = null;
        }

        if (c.closed || session.stopped) return;

        pump(session);
    });

    reader.on("error", err => {
        if (c.reader === reader) {
            c.reader = null;
        }

        if (!c.closed) {
            c.res.destroy(err);
        }
    });
}

// ========================================
// ATTACH ESP32 CONSUMER
// ========================================

function attachConsumer(session, res) {
    if (session.consumer) {
        session.consumer.closed = true;

        if (session.consumer.reader) {
            session.consumer.reader.destroy();
        }

        if (session.consumer.timer) {
            clearTimeout(session.consumer.timer);
        }
    }

    const c = {
        res,
        reader: null,
        timer: null,
        closed: false
    };

    session.consumer = c;

    res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "Accept-Ranges": "none",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive"
    });

    res.on("close", () => {
        c.closed = true;

        if (c.reader) {
            c.reader.destroy();
        }

        if (c.timer) {
            clearTimeout(c.timer);
        }

        // IMPORTANT:
        // Do not stop producer.
        // Keep FIFO data for reconnect.
        if (session.consumer === c) {
            session.consumer = null;
        }
    });

    pump(session);
}

// ========================================
// STREAM
// ========================================

app.get("/stream", (req, res) => {
    const id = String(req.query.id || "esp32");
    const url = String(req.query.url || "");

    let session = sessions.get(id);

    if (!session) {
        if (!validTrackUrl(url)) {
            return res.status(400).json({
                success: false,
                error: "Missing or invalid SoundCloud URL"
            });
        }

        session = createSession(id, url);
    }

    attachConsumer(session, res);
});

// ========================================
// PAUSE
// ========================================

app.post("/pause", (req, res) => {
    const id = String(req.body.id || "esp32");
    const session = sessions.get(id);

    if (!session) {
        return res.status(404).json({
            success: false,
            error: "Session not found"
        });
    }

    session.paused = true;

    if (session.consumer &&
        session.consumer.reader) {
        session.consumer.reader.pause();
    }

    res.json({
        success: true,
        paused: true,
        bufferedBytes: session.size - session.offset,
        playedBytes: session.offset,
        totalBytes: session.size
    });
});

// ========================================
// RESUME
// ========================================

app.post("/resume", (req, res) => {
    const id = String(req.body.id || "esp32");
    const session = sessions.get(id);

    if (!session) {
        return res.status(404).json({
            success: false,
            error: "Session not found"
        });
    }

    session.paused = false;

    const c = session.consumer;

    if (c && c.reader) {
        c.reader.resume();
    } else {
        pump(session);
    }

    res.json({
        success: true,
        resumed: true,
        position: session.offset,
        bufferedBytes: session.size - session.offset
    });
});

// ========================================
// STATUS
// ========================================

app.get("/status", (req, res) => {
    const id = String(req.query.id || "esp32");
    const s = sessions.get(id);

    if (!s) {
        return res.status(404).json({
            success: false,
            error: "Session not found"
        });
    }

    res.json({
        success: true,
        id: s.id,

        paused: s.paused,
        downloading: !s.producerDone,
        finished: s.producerDone,

        playedBytes: s.offset,
        totalBytes: s.size,
        bufferedBytes: Math.max(0, s.size - s.offset),

        bufferSeconds: Math.floor(
            Math.max(0, s.size - s.offset) / 16000
        ),

        error: s.error
    });
});

// ========================================
// STOP AND DELETE SESSION
// ========================================

function stopSession(id) {
    const s = sessions.get(id);

    if (!s) return false;

    s.stopped = true;

    killProcess(s.downloader);
    killProcess(s.transcoder);

    if (s.consumer) {
        s.consumer.closed = true;

        if (s.consumer.reader) {
            s.consumer.reader.destroy();
        }

        if (s.consumer.timer) {
            clearTimeout(s.consumer.timer);
        }

        if (!s.consumer.res.destroyed) {
            s.consumer.res.end();
        }
    }

    if (s.writer && !s.writer.destroyed) {
        s.writer.destroy();
    }

    sessions.delete(id);

    const removeFile = () => {
        fs.rm(s.file, { force: true }, () => {});
    };

    if (s.writer && !s.writer.closed) {
        s.writer.once("close", removeFile);
    } else {
        removeFile();
    }

    return true;
}

app.post("/stop", (req, res) => {
    const id = String(req.body.id || "esp32");

    const stopped = stopSession(id);

    res.json({
        success: stopped,
        stopped
    });
});

// ========================================
// START
// ========================================

app.listen(PORT, "0.0.0.0", () => {
    console.log("--------------------------------");
    console.log("SoundCloud FIFO Server");
    console.log("Port:", PORT);
    console.log("Format: MP3 128kbps");
    console.log("Buffer: Disk FIFO");
    console.log("Pause: /pause");
    console.log("Resume: /resume");
    console.log("--------------------------------");
});
