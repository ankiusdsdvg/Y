JavaScript

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const http = require("http");
const https = require("https");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";

const sessions = new Map();

// ======================================
// YT-DLP EXECUTOR
// ======================================

function runYtDlp(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const proc = spawn(YTDLP, args, {
            windowsHide: true
        });

        let stdout = "";
        let stderr = "";
        let finished = false;

        const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            finish(new Error("yt-dlp timeout"));
        }, timeout);

        function finish(error, result) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);

            if (error) reject(error);
            else resolve(result);
        }

        proc.stdout.on("data", data => {
            stdout += data.toString();
        });

        proc.stderr.on("data", data => {
            stderr += data.toString();
        });

        proc.on("error", error => finish(error));

        proc.on("close", code => {
            if (code !== 0) {
                return finish(new Error(
                    stderr.trim() || "yt-dlp failed"
                ));
            }

            finish(null, stdout.trim());
        });
    });
}

// ======================================
// SEARCH SOUNDCLOUD
// ======================================

app.get("/search", async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();

        let limit = parseInt(req.query.limit || "10", 10);

        if (!q) {
            return res.status(400).json({
                success: false,
                error: "Missing search query"
            });
        }

        limit = Math.max(1, Math.min(limit || 10, 20));

        const output = await runYtDlp([
            "--no-warnings",
            "--ignore-errors",
            "--skip-download",
            "--flat-playlist",
            "--dump-single-json",
            `scsearch${limit}:${q}`
        ], 60000);

        const data = JSON.parse(output);

        const entries = data.entries || [];

        const results = entries
            .filter(item => item)
            .map(item => ({
                id: item.id || null,

                title: item.title || "Unknown",

                artist:
                    item.artist ||
                    item.uploader ||
                    item.creator ||
                    item.channel ||
                    "Unknown",

                duration: item.duration || 0,

                thumbnail:
                    item.thumbnail ||
                    (item.thumbnails &&
                     item.thumbnails.length
                        ? item.thumbnails[item.thumbnails.length - 1].url
                        : null),

                url:
                    item.webpage_url ||
                    item.original_url ||
                    (item.id
                        ? `https://soundcloud.com/${item.uploader_id}/${item.id}`
                        : null)
            }))
            .filter(item => item.url);

        res.json({
            success: true,
            source: "SoundCloud",
            count: results.length,
            results
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ======================================
// GET TRACK INFO
// ======================================

app.get("/info", async (req, res) => {
    try {
        const url = req.query.url;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: "Missing URL"
            });
        }

        const output = await runYtDlp([
            "--no-warnings",
            "--skip-download",
            "--dump-single-json",
            "--no-playlist",
            url
        ]);

        const item = JSON.parse(output);

        res.json({
            success: true,
            title: item.title,
            artist: item.artist || item.uploader,
            duration: item.duration,
            thumbnail: item.thumbnail,
            url: item.webpage_url
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ======================================
// GET DIRECT STREAM URL
// ======================================

async function getStreamUrl(url) {
    const output = await runYtDlp([
        "--no-warnings",
        "--no-playlist",
        "-f", "bestaudio[protocol^=http]/bestaudio",
        "-g",
        url
    ], 60000);

    const urls = output.split(/\r?\n/)
        .map(x => x.trim())
        .filter(x => /^https?:\/\//i.test(x));

    if (!urls.length) {
        throw new Error("Cannot get SoundCloud stream URL");
    }

    return urls[0];
}

app.get("/stream-url", async (req, res) => {
    try {
        const url = req.query.url;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: "Missing URL"
            });
        }

        const streamUrl = await getStreamUrl(url);

        res.json({
            success: true,
            stream_url: streamUrl
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ======================================
// HTTP STREAM REQUEST WITH REDIRECTS
// ======================================

function requestStream(url, res, session, redirects = 0) {
    if (session.stopped) return;

    if (redirects > 10) {
        res.destroy(new Error("Too many redirects"));
        return;
    }

    const client = url.startsWith("https:")
        ? https
        : http;

    const request = client.get(url, {
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "*/*",
            "Icy-MetaData": "0"
        }
    }, upstream => {

        if (
            [301, 302, 303, 307, 308].includes(upstream.statusCode)
        ) {
            const location = upstream.headers.location;
            upstream.resume();

            if (!location) {
                res.destroy(new Error("Redirect without location"));
                return;
            }

            session.request = null;

            requestStream(
                new URL(location, url).href,
                res,
                session,
                redirects + 1
            );

            return;
        }

        if (
            upstream.statusCode < 200 ||
            upstream.statusCode >= 300
        ) {
            upstream.resume();
            res.destroy(new Error(
                "Upstream HTTP " + upstream.statusCode
            ));
            return;
        }

        const contentType =
            upstream.headers["content-type"] || "application/octet-stream";

        if (contentType.includes("mpegurl")) {
            upstream.resume();
            res.destroy(new Error(
                "SoundCloud returned HLS, not a progressive audio stream"
            ));
            return;
        }

        res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "no-cache, no-store",
            "Accept-Ranges": "none",
            "X-Accel-Buffering": "no"
        });

        // Direct streaming.
        // Node.js automatically applies backpressure.
        // No artificial 128 kbps speed limit.
        // No whole-track buffering.

        upstream.pipe(res);

        upstream.on("error", error => {
            res.destroy(error);
        });
    });

    session.request = request;

    request.on("error", error => {
        if (!res.destroyed) {
            res.destroy(error);
        }
    });
}

// ======================================
// STOP SESSION
// ======================================

function stopSession(id) {
    const session = sessions.get(id);

    if (!session) return;

    session.stopped = true;

    if (session.request) {
        session.request.destroy();
    }

    sessions.delete(id);
}

// ======================================
// STREAM AUDIO
// ======================================

app.get("/stream", async (req, res) => {
    const url = req.query.url;
    const id = String(req.query.id || "default");

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "Missing URL"
        });
    }

    // Stop previous session with same ID.
    stopSession(id);

    const session = {
        stopped: false,
        request: null
    };

    sessions.set(id, session);

    res.on("close", () => {
        session.stopped = true;

        if (session.request) {
            session.request.destroy();
        }

        if (sessions.get(id) === session) {
            sessions.delete(id);
        }
    });

    try {
        const streamUrl = await getStreamUrl(url);

        if (session.stopped || res.destroyed) return;

        requestStream(streamUrl, res, session);

    } catch (error) {
        if (!res.headersSent && !res.destroyed) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }

        stopSession(id);
    }
});

// ======================================
// STOP API
// ======================================

app.post("/stop", (req, res) => {
    const id = String(req.body.id || "default");

    stopSession(id);

    res.json({
        success: true,
        stopped: true,
        id
    });
});

// ======================================
// SERVER STATUS
// ======================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        server: "SoundCloud Direct Stream",
        source: "SoundCloud",
        search: "/search?q=song",
        info: "/info?url=TRACK_URL",
        stream_url: "/stream-url?url=TRACK_URL",
        stream: "/stream?url=TRACK_URL&id=esp32",
        buffering: "Node.js backpressure",
        bitrate_limit: false
    });
});

// ======================================
// START SERVER
// ======================================

app.listen(PORT, () => {
    console.log("--------------------------------");
    console.log("SoundCloud Direct Stream");
    console.log("Port:", PORT);
    console.log("Search: /search?q=song");
    console.log("Stream: /stream?url=...");
    console.log("--------------------------------");
});
