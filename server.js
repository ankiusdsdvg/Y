
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

const CACHE_DIR = path.join(__dirname, "audio_cache");

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const jobs = new Map();

function makeId(url) {
    return crypto.createHash("sha256")
        .update(url)
        .digest("hex");
}

function validUrl(url) {
    try {
        const u = new URL(url);

        return u.protocol === "https:" &&
            (u.hostname === "soundcloud.com" ||
             u.hostname.endsWith(".soundcloud.com"));
    } catch {
        return false;
    }
}

function filePath(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    return path.join(CACHE_DIR, id + ".mp3");
}

function runJson(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(YTDLP, args);

        let output = "";
        let error = "";

        child.stdout.on("data", d => {
            output += d.toString();

            if (output.length > 5 * 1024 * 1024) {
                child.kill();
                reject(new Error("Output too large"));
            }
        });

        child.stderr.on("data", d => {
            error += d.toString();
        });

        child.on("error", reject);

        child.on("close", code => {
            if (code !== 0) {
                reject(new Error(error || "yt-dlp error"));
                return;
            }

            try {
                resolve(JSON.parse(output));
            } catch {
                reject(new Error("Invalid JSON"));
            }
        });
    });
}

// ===============================
// SEARCH SOUNDCLOUD
// ===============================

app.get("/api/soundcloud/search", async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();

        if (!q) {
            return res.status(400).json({
                success: false,
                error: "Missing search query"
            });
        }

        const data = await runJson([
            "--dump-single-json",
            "--flat-playlist",
            "--no-warnings",
            "--no-download",
            "scsearch10:" + q
        ]);

        const results = (data.entries || []).map(item => ({
            id: item.id,
            title: item.title,
            artist: item.uploader || item.artist || "",
            duration: item.duration || 0,
            thumbnail: item.thumbnail || null,
            url: item.url || item.webpage_url
        }));

        res.json({
            success: true,
            source: "SoundCloud",
            count: results.length,
            results
        });

    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// ===============================
// PREPARE AUDIO
// ===============================

function prepareAudio(url, id) {
    const finalFile = filePath(id);
    const tempFile = finalFile + ".part";

    if (jobs.has(id)) return jobs.get(id);

    const job = {
        status: "processing",
        progress: "Downloading",
        error: null,
        size: 0
    };

    jobs.set(id, job);

    let finished = false;
    let timer;

    function fail(message) {
        if (finished) return;

        finished = true;
        clearTimeout(timer);

        job.status = "error";
        job.error = message;

        try {
            fs.unlinkSync(tempFile);
        } catch {}

    }

    const downloader = spawn(YTDLP, [
        "--no-warnings",
        "--no-progress",
        "--no-playlist",
        "--no-part",
        "--retries", "5",
        "--fragment-retries", "5",
        "--socket-timeout", "30",
        "-f", "bestaudio/best",
        "-o", "-",
        url
    ]);

    const transcoder = spawn(FFMPEG, [
        "-hide_banner",
        "-loglevel", "error",
        "-i", "pipe:0",
        "-vn",
        "-ac", "2",
        "-ar", "44100",
        "-b:a", "128k",
        "-codec:a", "libmp3lame",
        "-write_xing", "1",
        "-id3v2_version", "3",
        "-y",
        tempFile
    ]);

    downloader.stdout.pipe(transcoder.stdin);

    let ffmpegError = "";

    transcoder.stderr.on("data", d => {
        ffmpegError += d.toString();
    });

    downloader.stderr.on("data", d => {
        // Có thể bổ sung phân tích tiến độ yt-dlp tại đây.
    });

    downloader.on("error", e => fail(e.message));
    transcoder.on("error", e => fail(e.message));

    downloader.on("close", code => {
        if (code !== 0) {
            fail("yt-dlp: download failed");
            return;
        }

        job.progress = "Converting MP3";
    });

    transcoder.on("close", async code => {
        if (finished) return;

        if (code !== 0) {
            fail(ffmpegError || "FFmpeg conversion failed");
            return;
        }

        try {
            const stat = fs.statSync(tempFile);

            if (stat.size <= 0) {
                fail("Empty audio file");
                return;
            }

            fs.renameSync(tempFile, finalFile);

            finished = true;
            clearTimeout(timer);

            job.status = "ready";
            job.progress = "Completed";
            job.size = stat.size;

        } catch (e) {
            fail(e.message);
        }
    });

    timer = setTimeout(() => {
        try { downloader.kill("SIGKILL"); } catch {}
        try { transcoder.kill("SIGKILL"); } catch {}
        fail("Processing timeout");
    }, 30 * 60 * 1000);

    return job;
}

// ===============================
// STREAM LINK API
// ===============================

app.get("/api/soundcloud/stream-link", async (req, res) => {
    try {
        const url = String(req.query.url || "");

        if (!validUrl(url)) {
            return res.status(400).json({
                success: false,
                error: "Invalid SoundCloud URL"
            });
        }

        const id = makeId(url);
        const file = filePath(id);

        if (fs.existsSync(file)) {
            const stat = fs.statSync(file);

            return res.json({
                success: true,
                status: "ready",
                id,
                title: "",
                quality: "128kbps",
                size: stat.size,
                url: `${req.protocol}://${req.get("host")}/api/stream/${id}`
            });
        }

        const job = prepareAudio(url, id);

        res.status(202).json({
            success: true,
            status: job.status,
            id,
            message: "Audio is being prepared",
            status_url: `/api/soundcloud/status?id=${id}`,
            retry_after: 3
        });

    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// ===============================
// STATUS API
// ===============================

app.get("/api/soundcloud/status", (req, res) => {
    const id = String(req.query.id || "");
    const file = filePath(id);

    if (!file) {
        return res.status(400).json({
            success: false,
            error: "Invalid ID"
        });
    }

    if (fs.existsSync(file)) {
        const stat = fs.statSync(file);

        return res.json({
            success: true,
            status: "ready",
            size: stat.size,
            stream_url: `/api/stream/${id}`
        });
    }

    const job = jobs.get(id);

    if (!job) {
        return res.status(404).json({
            success: false,
            status: "not_found"
        });
    }

    res.json({
        success: true,
        status: job.status,
        progress: job.progress,
        error: job.error
    });
});

// ===============================
// DIRECT STREAM WITH HTTP RANGE
// ===============================

function streamFile(req, res, id) {
    const file = filePath(id);

    if (!file || !fs.existsSync(file)) {
        return res.status(404).json({
            success: false,
            error: "Audio not ready"
        });
    }

    const stat = fs.statSync(file);
    const size = stat.size;

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Expose-Headers",
        "Content-Length, Content-Range, Accept-Ranges");

    const range = req.headers.range;

    if (!range) {
        res.status(200);
        res.setHeader("Content-Length", size);

        if (req.method === "HEAD") {
            return res.end();
        }

        return fs.createReadStream(file).pipe(res);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);

    if (!match) {
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.status(416).end();
    }

    let start;
    let end;

    if (match[1] === "") {
        const suffix = Number(match[2]);

        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
            res.setHeader("Content-Range", `bytes */${size}`);
            return res.status(416).end();
        }

        start = Math.max(0, size - suffix);
        end = size - 1;

    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
    }

    if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= size ||
        end < start
    ) {
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.status(416).end();
    }

    end = Math.min(end, size - 1);

    res.status(206);

    res.setHeader(
        "Content-Range",
        `bytes ${start}-${end}/${size}`
    );

    res.setHeader(
        "Content-Length",
        end - start + 1
    );

    if (req.method === "HEAD") {
        return res.end();
    }

    const read = fs.createReadStream(file, {
        start,
        end
    });

    read.on("error", () => {
        if (!res.headersSent) res.status(500);
        res.end();
    });

    read.pipe(res);
}

app.get("/api/stream/:id", (req, res) => {
    streamFile(req, res, req.params.id);
});

app.head("/api/stream/:id", (req, res) => {
    streamFile(req, res, req.params.id);
});

// ===============================
// HEALTH
// ===============================

app.get("/", (req, res) => {
    res.send("SoundCloud MP3 Streaming Server OK");
});

app.get("/health", (req, res) => {
    res.json({
        success: true,
        service: "SoundCloud Streaming",
        cache: jobs.size
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
