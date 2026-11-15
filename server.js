"use strict";
const yts = require("yt-search");
const ytdl = require("@distube/ytdl-core");

const API_TOKEN = (process.env.API_TOKEN || "").trim();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isAuthorized(req) {
  if (!API_TOKEN) return true;
  const key = (req.headers["x-api-key"] || "").trim();
  return key === API_TOKEN;
}

async function ytSearch(query, limit = 5) {
  const result = await yts(query);
  const videos = Array.isArray(result.videos) ? result.videos.slice(0, limit) : [];

  return videos.map((item) => ({
    encodeId: item.videoId,
    id: item.videoId,
    title: item.title || "Unknown Title",
    artistsNames: item.author?.name || "YouTube",
    duration: item.seconds || 0,
    thumbnail: item.thumbnail || "",
  }));
}

async function ytGetStream(videoId) {
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
    throw new Error("Invalid YouTube video ID");
  }
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const info = await ytdl.getInfo(url);

  // Ưu tiên định dạng m4a / mp4 audio (AAC) để ESP32 giải mã mượt nhất
  const audioFormats = ytdl.filterFormats(info.formats, "audioonly");
  const preferred =
    audioFormats.find((f) => f.container === "mp4" || f.container === "m4a") ||
    audioFormats[0];

  if (!preferred || !preferred.url) {
    throw new Error("Failed to extract YouTube audio stream URL");
  }
  return preferred.url;
}

// Vercel Serverless Function handler (tương thích hoàn toàn với vercel.json)
module.exports = async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/health") {
      return json(res, 200, { ok: true, provider: "youtube-vercel" });
    }

    if (!isAuthorized(req)) {
      return json(res, 401, { err: -1, msg: "Unauthorized" });
    }

    if (requestUrl.pathname === "/api/search") {
      const query = (requestUrl.searchParams.get("q") || "").trim();
      if (!query) return json(res, 400, { err: -1, msg: "Missing query q" });

      const songs = await ytSearch(query, 5);
      return json(res, 200, {
        err: 0,
        msg: "Success",
        data: { songs },
      });
    }

    if (requestUrl.pathname === "/api/song") {
      const id = (requestUrl.searchParams.get("id") || "").trim();
      if (!id) return json(res, 400, { err: -1, msg: "Missing id" });

      const streamUrl = await ytGetStream(id);
      return json(res, 200, {
        err: 0,
        msg: "Success",
        data: {
          "128": streamUrl,
          "320": streamUrl,
        },
      });
    }

    if (requestUrl.pathname === "/api/song/stream") {
      const id = (requestUrl.searchParams.get("id") || "").trim();
      if (!id) return json(res, 400, { err: -1, msg: "Missing id" });

      const streamUrl = await ytGetStream(id);
      res.writeHead(302, { location: streamUrl });
      return res.end();
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 500, { err: -1, error: error.message });
  }
};
