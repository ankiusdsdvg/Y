const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { dbPath } = require("./config");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'youtube',
  query_text TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS youtube_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_id, video_id)
);
`);

const statements = {
  saveSearch: db.prepare("INSERT INTO search_history(device_id,type,query_text,result_json) VALUES(?,?,?,?)"),
  savePlay: db.prepare("INSERT INTO youtube_history(device_id,video_id,title,channel,url) VALUES(?,?,?,?,?)"),
  history: db.prepare("SELECT * FROM youtube_history WHERE device_id=? ORDER BY played_at DESC,id DESC LIMIT ?"),
  favorites: db.prepare("SELECT * FROM favorites WHERE device_id=? ORDER BY created_at DESC,id DESC"),
  addFavorite: db.prepare(`INSERT INTO favorites(device_id,video_id,title,channel,url) VALUES(?,?,?,?,?)
    ON CONFLICT(device_id,video_id) DO UPDATE SET title=excluded.title,channel=excluded.channel,url=excluded.url`),
  removeFavorite: db.prepare("DELETE FROM favorites WHERE device_id=? AND video_id=?")
};

function cleanDeviceId(value) {
  const id = String(value || "default").trim().slice(0, 80);
  return id || "default";
}
function saveSearch(deviceId, q, results) {
  statements.saveSearch.run(cleanDeviceId(deviceId), "youtube", q, JSON.stringify(results));
}
function savePlay(deviceId, video) {
  statements.savePlay.run(cleanDeviceId(deviceId), video.videoId, video.title || video.videoId,
    video.channel || "", video.url || `https://www.youtube.com/watch?v=${video.videoId}`);
}
function history(deviceId, limit = 20) {
  return statements.history.all(cleanDeviceId(deviceId), Math.min(Math.max(Number(limit) || 20, 1), 100));
}
function favorites(deviceId) {
  return statements.favorites.all(cleanDeviceId(deviceId));
}
function addFavorite(deviceId, video) {
  statements.addFavorite.run(cleanDeviceId(deviceId), video.videoId, video.title || video.videoId,
    video.channel || "", video.url || `https://www.youtube.com/watch?v=${video.videoId}`);
}
function removeFavorite(deviceId, videoId) {
  statements.removeFavorite.run(cleanDeviceId(deviceId), String(videoId || ""));
}
module.exports = { saveSearch, savePlay, history, favorites, addFavorite, removeFavorite };
