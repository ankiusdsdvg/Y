const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const https = require("https");
const http = require("http");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";

const sessions = new Map();

function getStreamUrl(url) {
    return new Promise((resolve, reject) => {
        const args = [
            "--no-warnings",
            "--no-playlist",
            "-f", "bestaudio",
            "-g",
            url
        ];

        const proc = spawn(YTDLP, args);
        let output = "";
        let error = "";

        proc.stdout.on("data", d => output += d.toString());
        proc.stderr.on("data", d => error += d.toString());

        proc.on("error", reject);

        proc.on("close", code => {
            const streamUrl = output.trim().split(/\r?\n/)[0];

            if (code !== 0 || !streamUrl) {
                return reject(new Error(error || "Không lấy được stream URL"));
            }

            resolve(streamUrl);
        });
    });
}

function stopSession(id) {
    const session = sessions.get(id);
    if (!session) return;

    session.stopped = true;

    if (session.request) {
        session.request.destroy();
    }

    sessions.delete(id);
}

// Lấy URL stream
app.get("/stream-url", async (req, res) => {
    try {
        const url = req.query.url;

        if (!url) {
            return res.status(400).json({
                success: false,
                error: "Thiếu URL"
            });
        }

        const streamUrl = await getStreamUrl(url);

        res.json({
            success: true,
            stream_url: streamUrl
        });

    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// Phát MP3 trực tiếp qua server
app.get("/stream", async (req, res) => {
    const source = req.query.url;
    const id = req.query.id || "default";

    if (!source) {
        return res.status(400).send("Missing URL");
    }

    stopSession(id);

    const session = {
        stopped: false,
        request: null
    };

    sessions.set(id, session);

    try {
        const streamUrl = await getStreamUrl(source);

        if (session.stopped) return;

        const client = streamUrl.startsWith("https:")
            ? https
            : http;

        const upstream = client.get(streamUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Accept": "*/*"
            }
        }, upstreamRes => {

            if (upstreamRes.statusCode < 200 ||
                upstreamRes.statusCode >= 300) {
                stopSession(id);

                if (!res.headersSent) {
                    res.status(502).end("Upstream error");
                }
                return;
            }

            res.status(200);
            res.setHeader("Content-Type",
                upstreamRes.headers["content-type"] || "audio/mpeg");

            res.setHeader("Cache-Control", "no-cache, no-store");
            res.setHeader("Accept-Ranges", "none");

            // Không tự giới hạn bitrate.
            // Không tích lũy toàn bộ bài hát.
            // Chuyển tiếp theo cơ chế backpressure.
            upstreamRes.pipe(res);

            upstreamRes.on("error", () => {
                res.destroy();
                stopSession(id);
            });

            res.on("close", () => {
                stopSession(id);
            });
        });

        session.request = upstream;

        upstream.on("error", err => {
            if (!res.headersSent) {
                res.status(502).send(err.message);
            } else {
                res.destroy();
            }

            stopSession(id);
        });

    } catch (e) {
        stopSession(id);

        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: e.message
            });
        }
    }
});

// Dừng stream
app.post("/stop", (req, res) => {
    const id = req.body.id || "default";
    stopSession(id);

    res.json({ success: true });
});

// Kiểm tra server
app.get("/", (req, res) => {
    res.json({
        success: true,
        server: "SoundCloud Direct Stream",
        mode: "HTTP streaming",
        buffering: "Node.js backpressure",
        bitrate_limit: false
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
