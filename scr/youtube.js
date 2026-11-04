const { spawn } = require("node:child_process");
const ytSearch = require("yt-search");
const {
  ytDlpBin, ytDlpJsRuntime, searchTimeoutMs, extractTimeoutMs, maxSearch
} = require("./config");

function videoUrl(id) {
  return /^https?:\/\//i.test(String(id))
    ? String(id)
    : `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}
function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function baseArgs() {
  const args = ["--ignore-config", "--no-warnings", "--no-progress"];
  if (ytDlpJsRuntime) args.push("--js-runtimes", ytDlpJsRuntime);
  return args;
}
function runYtDlp(args, timeoutMs = extractTimeoutMs, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ytDlpBin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      reject(new Error(`Không chạy được yt-dlp: ${err.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("yt-dlp timeout"));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > maxBytes) {
        child.kill("SIGKILL");
        finish(new Error("yt-dlp output quá lớn"));
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-5000); });
    child.once("error", err => finish(new Error(`yt-dlp error: ${err.message}`)));
    child.once("close", code => {
      if (settled) return;
      if (code === 0) finish(null, stdout);
      else finish(new Error(stderr.trim() || `yt-dlp thoát với mã ${code}`));
    });
  });
}
function normalizeEntry(v) {
  const id = String(v?.id || v?.url || "").trim();
  if (!id) return null;
  return {
    videoId: id,
    title: v.title || v.fulltitle || id,
    channel: v.channel || v.uploader || v.channel_id || "",
    duration: v.duration_string || (Number.isFinite(Number(v.duration)) ? formatDuration(v.duration) : ""),
    views: Number(v.view_count) || 0,
    thumbnail: v.thumbnail || v.thumbnails?.at?.(-1)?.url || "",
    url: videoUrl(id)
  };
}
function parseSearchOutput(output, limit) {
  const found = [];
  const seen = new Set();
  for (const line of String(output).split(/\r?\n/).filter(Boolean)) {
    try {
      const obj = JSON.parse(line);
      const entries = Array.isArray(obj.entries) ? obj.entries : [obj];
      for (const entry of entries) {
        const item = normalizeEntry(entry);
        if (!item || seen.has(item.videoId)) continue;
        seen.add(item.videoId);
        found.push(item);
        if (found.length >= limit) return found;
      }
    } catch {}
  }
  return found;
}
async function searchYouTube(query, limit = 10) {
  const q = String(query || "").trim();
  if (!q || q.length > 120) throw new Error("q phải có từ 1 đến 120 ký tự");
  const count = Math.min(Math.max(Number(limit) || 10, 1), maxSearch);
  let firstError;
  try {
    const args = [...baseArgs(), "--flat-playlist", "--dump-json", "--skip-download",
      "--playlist-end", String(count), `ytsearch${count}:${q}`];
    const output = await runYtDlp(args, searchTimeoutMs);
    const videos = parseSearchOutput(output, count);
    if (videos.length) return videos;
    firstError = new Error("yt-dlp không trả về kết quả");
  } catch (err) { firstError = err; }

  try {
    const result = await Promise.race([
      ytSearch(q),
      new Promise((_, reject) => setTimeout(() => reject(new Error("yt-search timeout")), 12000))
    ]);
    const videos = (result.videos || []).slice(0, count).map(v => ({
      videoId: v.videoId, title: v.title || v.videoId,
      channel: v.author?.name || "", duration: v.timestamp || "",
      views: Number(v.views) || 0, thumbnail: v.thumbnail || "",
      url: videoUrl(v.videoId)
    }));
    if (videos.length) return videos;
    throw new Error("Không tìm thấy video");
  } catch (fallbackError) {
    throw new Error(`yt-dlp: ${firstError.message}; yt-search: ${fallbackError.message}`);
  }
}
async function getVideoInfo(id) {
  const url = videoUrl(String(id || "").trim());
  const output = await runYtDlp([...baseArgs(), "--dump-single-json", "--skip-download", url]);
  const v = JSON.parse(output);
  return {
    videoId: v.id, title: v.title || "", channel: v.channel || v.uploader || "",
    duration: v.duration_string || formatDuration(v.duration),
    views: Number(v.view_count) || 0, thumbnail: v.thumbnail || "",
    description: v.description || "", webpageUrl: v.webpage_url || url,
    formats: (v.formats || []).filter(f => f.url).map(f => ({
      formatId: f.format_id, ext: f.ext, resolution: f.resolution || "",
      height: f.height || null, fps: f.fps || null, audioCodec: f.acodec,
      videoCodec: f.vcodec, filesize: f.filesize || f.filesize_approx || null
    }))
  };
}
async function getStreamInfo(id, kind = "audio") {
  const url = videoUrl(String(id || "").trim());
  const format = "bestaudio[protocol^=https]/bestaudio";
  kind = "audio";
  const output = await runYtDlp([...baseArgs(), "--no-playlist", "-f", format, "--get-url", url]);
  const lines = output.trim().split(/\r?\n/);
  const streamUrl = lines.find(line => /^https?:\/\//i.test(line.trim()));
  if (!streamUrl) throw new Error("Không lấy được URL stream");
  return { videoId: String(id), type: kind, streamUrl: streamUrl.trim(), expiresNote: "URL có thể hết hạn; hãy gọi lại API để lấy URL mới." };
}
function pipeAudioToMp3(id, req, res) {
  const url = videoUrl(String(id || "").trim());
  const ytdlpArgs = [...baseArgs(), "-f", "bestaudio", "-o", "-", url];
  const ffmpegArgs = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn",
    "-codec:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1"];
  const ytdlp = spawn(ytDlpBin, ytdlpArgs, { stdio: ["ignore", "pipe", "pipe"] });
  const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    ytdlp.kill("SIGKILL");
    ffmpeg.kill("SIGKILL");
  };
  res.on("close", () => { if (!res.writableEnded) stop(); });
  ytdlp.stderr.on("data", c => { stderr = (stderr + c.toString()).slice(-3000); });
  ffmpeg.stderr.on("data", c => { stderr = (stderr + c.toString()).slice(-3000); });
  ytdlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(res);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  ytdlp.once("error", err => { if (!res.headersSent) res.status(500).json({ error: err.message }); stop(); });
  ffmpeg.once("error", err => { if (!res.headersSent) res.status(500).json({ error: err.message }); stop(); });
  ytdlp.once("close", code => {
    if (code && !closed) {
      if (!res.headersSent) res.status(502).json({ error: stderr || "yt-dlp failed" });
      else res.end();
      stop();
    }
  });
  ffmpeg.once("close", () => { if (!closed) { res.end(); stop(); } });
}
module.exports = { searchYouTube, getVideoInfo, getStreamInfo, pipeAudioToMp3 };
