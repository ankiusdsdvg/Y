const path = require("node:path");

module.exports = {
  port: Number(process.env.PORT || 10000),
  host: "0.0.0.0",
  dbPath: process.env.DB_PATH || path.join(process.cwd(), "data", "youtube.sqlite"),
  ytDlpBin: process.env.YT_DLP_BIN || "yt-dlp",
  ytDlpJsRuntime: process.env.YT_DLP_JS_RUNTIME || "",
  searchTimeoutMs: Number(process.env.SEARCH_TIMEOUT_MS || 25000),
  extractTimeoutMs: Number(process.env.EXTRACT_TIMEOUT_MS || 30000),
  maxSearch: 20
};
