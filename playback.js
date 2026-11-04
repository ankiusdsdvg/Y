const { spawn } = require("node:child_process");
const { ytDlpBin, ytDlpJsRuntime, ytCookies, extractTimeoutMs } = require("./config");

const WIDTH = Number(process.env.PLAYBACK_WIDTH || 320);
const HEIGHT = Number(process.env.PLAYBACK_HEIGHT || 180);
const FPS = Number(process.env.PLAYBACK_FPS || 10);
const JPEG_QUALITY = Number(process.env.PLAYBACK_JPEG_QUALITY || 8);
const AUDIO_RATE = Number(process.env.PLAYBACK_AUDIO_RATE || 16000);
const AUDIO_CHANNELS = 1;
const AUDIO_FRAME_MS = 20;
const AUDIO_FRAME_BYTES = AUDIO_RATE * AUDIO_CHANNELS * 2 * AUDIO_FRAME_MS / 1000;
const MAX_AUDIO_BUFFER = AUDIO_RATE * AUDIO_CHANNELS * 2 * 0.6;
const MAX_JPEG_BYTES = 512 * 1024;
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

let child = null;
let currentId = null;
let generation = 0;
let jpegPending = Buffer.alloc(0);
let latestFrame = null;
let frameSequence = 0;
let lastFrameAt = 0;
let audioBuffer = Buffer.alloc(0);
let audioTimer = null;
let watchdog = null;
let restartTimer = null;
let stopping = false;
let starting = false;
const videoClients = new Set();
const audioClients = new Set();
let stats = { droppedFrames: 0, invalidFrames: 0 };

function baseArgs() {
  const args = ["--ignore-config", "--no-warnings", "--no-progress", "--no-playlist"];
  if (ytDlpJsRuntime) args.push("--js-runtimes", ytDlpJsRuntime);
  if (ytCookies) args.push("--cookies", ytCookies);
  return args;
}
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpBin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "", done = false;
    const timer = setTimeout(() => { proc.kill("SIGKILL"); finish(new Error("yt-dlp timeout")); }, extractTimeoutMs);
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    proc.stdout.on("data", c => { out += c.toString(); if (out.length > 200000) { proc.kill("SIGKILL"); finish(new Error("yt-dlp output too large")); } });
    proc.stderr.on("data", c => { err = (err + c.toString()).slice(-5000); });
    proc.once("error", e => finish(e));
    proc.once("close", code => code === 0 ? finish(null, out.trim()) : finish(new Error(err.trim() || `yt-dlp exited ${code}`)));
  });
}
async function resolveInputs(id) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  const output = await runYtDlp([...baseArgs(), "-f", "bestvideo+bestaudio/best", "--get-url", url]);
  const urls = output.split(/\r?\n/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));
  if (!urls.length) throw new Error("Không lấy được luồng video YouTube");
  return urls.slice(0, 2);
}
function clearMedia() {
  jpegPending = Buffer.alloc(0);
  latestFrame = null;
  frameSequence = 0;
  audioBuffer = Buffer.alloc(0);
  lastFrameAt = 0;
}
function parseJpegs(chunk, gen) {
  if (gen !== generation) return;
  jpegPending = Buffer.concat([jpegPending, chunk]);
  while (jpegPending.length) {
    const start = jpegPending.indexOf(SOI);
    if (start < 0) { jpegPending = jpegPending.at(-1) === 0xff ? jpegPending.subarray(-1) : Buffer.alloc(0); return; }
    if (start) jpegPending = jpegPending.subarray(start);
    const end = jpegPending.indexOf(EOI, 2);
    if (end < 0) {
      if (jpegPending.length > MAX_JPEG_BYTES) { stats.invalidFrames++; jpegPending = Buffer.alloc(0); }
      return;
    }
    const frame = Buffer.from(jpegPending.subarray(0, end + 2));
    if (latestFrame) stats.droppedFrames++;
    latestFrame = frame;
    frameSequence++;
    lastFrameAt = Date.now();
    jpegPending = jpegPending.subarray(end + 2);
  }
}
function pushAudio(chunk) {
  if (!chunk?.length) return;
  audioBuffer = Buffer.concat([audioBuffer, chunk]);
  if (audioBuffer.length > MAX_AUDIO_BUFFER) audioBuffer = audioBuffer.subarray(audioBuffer.length - MAX_AUDIO_BUFFER);
}
function nextAudioFrame() {
  const frame = Buffer.alloc(AUDIO_FRAME_BYTES);
  const n = Math.min(audioBuffer.length, AUDIO_FRAME_BYTES);
  if (n) {
    audioBuffer.copy(frame, 0, 0, n);
    audioBuffer = audioBuffer.subarray(n);
  }
  return frame;
}
function startAudioClock() {
  if (audioTimer) clearInterval(audioTimer);
  audioTimer = setInterval(() => {
    if (!audioClients.size) return;
    const frame = nextAudioFrame();
    for (const res of audioClients) {
      if (res.destroyed || res.writableEnded) { audioClients.delete(res); continue; }
      if (!res.write(frame)) {
        // A slow audio client is isolated; disconnect rather than building an unbounded queue.
        audioClients.delete(res);
        res.destroy();
      }
    }
  }, AUDIO_FRAME_MS);
}
function stopProcess() {
  generation++;
  if (watchdog) clearInterval(watchdog);
  if (restartTimer) clearTimeout(restartTimer);
  watchdog = restartTimer = null;
  if (child) { const old = child; child = null; try { old.kill("SIGKILL"); } catch {} }
  clearMedia();
}
async function start(id, allowRestart = true) {
  if (starting) throw new Error("Đang khởi tạo luồng khác, vui lòng thử lại");
  starting = true;
  stopping = false;
  stopProcess();
  currentId = id;
  stats = { droppedFrames: 0, invalidFrames: 0 };
  const gen = generation;
  try {
    const urls = await resolveInputs(id);
    if (gen !== generation || stopping) return;
    const args = ["-hide_banner", "-loglevel", "warning", "-threads", "2"];
    for (const url of urls) args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-user_agent", "Mozilla/5.0", "-i", url);
    const audioInput = urls.length > 1 ? "1:a:0" : "0:a:0";
    args.push(
      "-map", "0:v:0", "-an", "-vf",
      `fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      "-q:v", String(JPEG_QUALITY), "-threads", "1", "-flush_packets", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
      "-map", audioInput, "-vn", "-af", `aresample=${AUDIO_RATE}:async=100:first_pts=0`,
      "-ac", String(AUDIO_CHANNELS), "-ar", String(AUDIO_RATE), "-c:a", "pcm_s16le", "-flush_packets", "1", "-f", "s16le", "pipe:3"
    );
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true });
    child = proc;
    proc.stdout.on("data", c => parseJpegs(c, gen));
    proc.stdio[3]?.on("data", c => { if (gen === generation) pushAudio(c); });
    proc.stderr.on("data", c => console.warn("[playback ffmpeg]", c.toString().trim()));
    proc.once("error", e => console.error("[playback ffmpeg error]", e.message));
    proc.once("close", (code) => {
      if (gen !== generation) return;
      child = null;
      if (allowRestart && !stopping && currentId) scheduleRestart(id);
      else console.warn("[playback] ffmpeg exited", code);
    });
    watchdog = setInterval(() => {
      if (gen === generation && child && lastFrameAt && Date.now() - lastFrameAt > 45000) scheduleRestart(id);
    }, 5000);
    startAudioClock();
  } finally { starting = false; }
}
function scheduleRestart(id) {
  if (restartTimer || stopping) return;
  stopProcess();
  restartTimer = setTimeout(() => { restartTimer = null; if (!stopping && currentId === id) start(id).catch(e => console.error("[playback restart]", e.message)); }, 3000);
}
function stop() {
  stopping = true;
  currentId = null;
  stopProcess();
  for (const res of videoClients) res.end();
  for (const res of audioClients) res.end();
  videoClients.clear();
  audioClients.clear();
  if (audioTimer) clearInterval(audioTimer);
  audioTimer = null;
}
function videoStream(req, res) {
  res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  videoClients.add(res);
  let lastSeq = -1;
  let blocked = false;
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) { clearInterval(timer); videoClients.delete(res); return; }
    if (blocked || !latestFrame || frameSequence === lastSeq || Date.now() - lastFrameAt > 3000) return;
    const frame = latestFrame;
    const packet = Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`), frame, Buffer.from("\r\n")]);
    lastSeq = frameSequence;
    if (!res.write(packet)) { blocked = true; res.once("drain", () => { blocked = false; }); }
  }, Math.max(20, 1000 / FPS));
  res.on("close", () => { clearInterval(timer); videoClients.delete(res); });
}
function audioStream(req, res) {
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "Content-Encoding": "identity", "X-Audio-Format": `pcm_s16le;rate=${AUDIO_RATE};channels=1` });
  audioClients.add(res);
  startAudioClock();
  res.on("close", () => audioClients.delete(res));
}
function status() {
  return { running: !!child, videoId: currentId, width: WIDTH, height: HEIGHT, fps: FPS, audioFormat: "pcm_s16le", audioSampleRate: AUDIO_RATE, audioChannels: AUDIO_CHANNELS, videoClients: videoClients.size, audioClients: audioClients.size, frameSequence, lastFrameAgeMs: lastFrameAt ? Date.now() - lastFrameAt : null, audioBufferedBytes: audioBuffer.length, ...stats };
}
module.exports = { start, stop, videoStream, audioStream, status };
