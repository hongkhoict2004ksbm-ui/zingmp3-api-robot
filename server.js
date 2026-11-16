"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const yts = require("yt-search");

const PORT = Number(process.env.PORT || 5555);
const API_TOKEN = (process.env.API_TOKEN || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
let ytdlClientPromise;

function getYtdlClient() {
  if (!ytdlClientPromise) {
    ytdlClientPromise = import("@distube/ytdl-core").then(({ Ytdl, Quality }) => ({
      client: new Ytdl(),
      Quality,
    }));
  }
  return ytdlClientPromise;
}

function json(res, status, body) {
  if (res.headersSent) return res.end();
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
  return String(req.headers["x-api-key"] || "").trim() === API_TOKEN;
}

function getVideoId(value) {
  if (!value) throw new Error("Missing video ID");
  const input = String(value).trim();
  let id = input;
  try {
    const parsed = new URL(input);
    if (parsed.hostname === "youtu.be" || parsed.hostname.endsWith(".youtu.be")) {
      id = parsed.pathname.split("/").filter(Boolean)[0] || "";
    } else if (parsed.searchParams.has("v")) {
      id = parsed.searchParams.get("v");
    } else {
      const parts = parsed.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((part) => ["embed", "shorts", "live"].includes(part));
      if (marker >= 0) id = parts[marker + 1] || "";
    }
  } catch (_) {
    // A plain YouTube video ID is accepted below.
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("Invalid YouTube video ID");
  return id;
}

function videoUrl(id) {
  return "https://www.youtube.com/watch?v=" + getVideoId(id);
}

function publicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const forwardedHost = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const host = String(forwardedHost).split(",")[0].trim();
  const forwardedProto = req.headers["x-forwarded-proto"] || "http";
  const protocol = String(forwardedProto).split(",")[0].trim();
  return protocol + "://" + host;
}

async function searchVideos(query) {
  const result = await yts(query);
  const videos = Array.isArray(result.videos) ? result.videos : [];
  return videos.slice(0, 5).map((item) => {
    const id = item.videoId || item.id || "";
    return {
      encodeId: id,
      id,
      title: item.title || "Unknown title",
      artistsNames: item.author && item.author.name ? item.author.name : "YouTube",
      duration: Number(item.seconds || 0),
      thumbnail: item.thumbnail || "",
      thumbnailM: item.thumbnail || "",
    };
  }).filter((item) => /^[A-Za-z0-9_-]{11}$/.test(item.id));
}

async function videoInfo(id) {
  const { client } = await getYtdlClient();
  const info = await client.getInfo(videoUrl(id));
  const details = info.videoDetails || {};
  const thumbnails = Array.isArray(details.thumbnails) ? details.thumbnails : [];
  const thumbnail = thumbnails.length ? thumbnails[thumbnails.length - 1].url : "";
  return {
    encodeId: getVideoId(id),
    id: getVideoId(id),
    title: details.title || "Unknown title",
    artistsNames: details.author && details.author.name ? details.author.name : "YouTube",
    duration: Number(details.lengthSeconds || 0),
    thumbnail,
    thumbnailM: thumbnail,
  };
}

function startMp3Stream(req, res, id) {
  if (!ffmpegPath) throw new Error("FFmpeg binary is unavailable");

  let source = null;
  let ffmpeg = null;
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    console.error("YouTube MP3 stream failed:", error && error.message ? error.message : error);
    if (source && !source.destroyed) source.destroy();
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGKILL");
    if (!res.headersSent) json(res, 502, { err: -1, msg: "Unable to create MP3 audio stream" });
    else res.destroy();
  };

  getYtdlClient().then(({ client, Quality }) => client.getInfo(videoUrl(id)).then((info) => {
    if (settled || res.destroyed) return;
    source = client.download(info, {
      quality: Quality.HighestAudio,
      filter: { hasAudio: true, hasVideo: false },
      highWaterMark: 1 << 25,
    });
    ffmpeg = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vn", "-ac", "2", "-ar", "44100",
      "-codec:a", "libmp3lame", "-b:a", "128k",
      "-f", "mp3", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    res.writeHead(200, {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
      "content-disposition": "inline; filename=music.mp3",
      "x-content-type-options": "nosniff",
    });

    source.on("error", fail);
    ffmpeg.on("error", fail);
    ffmpeg.stdin.on("error", fail);
    ffmpeg.stderr.on("data", (chunk) => console.error("ffmpeg:", chunk.toString().trim()));
    ffmpeg.stdout.pipe(res);
    ffmpeg.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) return res.destroy(new Error("FFmpeg exited with code " + code));
      if (!res.writableEnded) res.end();
    });
    res.on("close", () => {
      if (!res.writableEnded && !settled) {
        settled = true;
        if (source && !source.destroyed) source.destroy();
        if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGKILL");
      }
    });
    source.pipe(ffmpeg.stdin);
  })).catch(fail);
}

async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    const path = requestUrl.pathname;

    if (path === "/health" || path === "/api/health") {
      return json(res, 200, { ok: true, provider: "youtube-mp3" });
    }
    if (!isAuthorized(req)) return json(res, 401, { err: -1, msg: "Unauthorized" });

    if (path === "/api/search") {
      const query = (requestUrl.searchParams.get("q") || "").trim();
      if (!query) return json(res, 400, { err: -1, msg: "Missing query q" });
      const songs = await searchVideos(query);
      return json(res, 200, { err: 0, msg: "Success", data: { songs } });
    }

    if (path === "/api/info-song") {
      const id = getVideoId(requestUrl.searchParams.get("id"));
      const song = await videoInfo(id);
      return json(res, 200, { err: 0, msg: "Success", data: song });
    }

    if (path === "/api/song") {
      const id = getVideoId(requestUrl.searchParams.get("id"));
      const streamUrl = publicBaseUrl(req) + "/api/audio?id=" + encodeURIComponent(id);
      return json(res, 200, { err: 0, msg: "Success", data: { "128": streamUrl } });
    }

    if (path === "/api/audio") {
      const id = getVideoId(requestUrl.searchParams.get("id"));
      startMp3Stream(req, res, id);
      return;
    }

    if (path === "/api/song/stream") {
      const id = getVideoId(requestUrl.searchParams.get("id"));
      const streamUrl = publicBaseUrl(req) + "/api/audio?id=" + encodeURIComponent(id);
      res.writeHead(302, { location: streamUrl, "cache-control": "no-store" });
      return res.end();
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("API request failed:", error && error.message ? error.message : error);
    return json(res, 502, { err: -1, msg: error.message || "Internal error" });
  }
}

module.exports = handler;

if (require.main === module) {
  http.createServer(handler).listen(PORT, "0.0.0.0", () => {
    console.log("YouTube MP3 API listening on port " + PORT);
  });
}
