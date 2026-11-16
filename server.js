"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const scdl = require("soundcloud-downloader").default;

const PORT = Number(process.env.PORT || 5555);
const API_TOKEN = (process.env.API_TOKEN || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");

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

function publicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return proto + "://" + host;
}

function trackId(value) {
  const id = String(value || "").trim().replace(/^soundcloud:tracks:/, "");
  if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid SoundCloud track ID");
  return id;
}

function trackToSong(track) {
  const id = track && track.id != null ? String(track.id) : "";
  if (!/^\d{1,20}$/.test(id)) return null;
  const artwork = track.artwork_url || track.user?.avatar_url || "";
  return {
    encodeId: id,
    id,
    title: track.title || "Unknown title",
    artistsNames: track.user?.username || track.publisher_metadata?.artist || "SoundCloud",
    duration: Math.floor(Number(track.duration || 0) / 1000),
    thumbnail: artwork,
    thumbnailM: artwork,
    sourceUrl: track.permalink_url || "",
  };
}

async function searchTracks(query) {
  const response = await scdl.search({ query, resourceType: "tracks", limit: 10 });
  const collection = Array.isArray(response) ? response : response?.collection;
  if (!Array.isArray(collection)) return [];
  return collection
    // The endpoint itself searches tracks; some API responses omit `kind`.
    .filter((item) => item && item.streamable !== false)
    .map(trackToSong)
    .filter(Boolean)
    .slice(0, 5);
}

async function getTrackInfo(id) {
  const numericId = Number(trackId(id));
  const tracks = await scdl.getTrackInfoByID([numericId]);
  const track = Array.isArray(tracks) ? tracks[0] : null;
  if (!track || !track.permalink_url) throw new Error("SoundCloud track not found or unavailable");
  return scdl.getInfo(track.permalink_url);
}

async function getStreamUrl(id) {
  const info = await getTrackInfo(id);
  const transcodings = info.media?.transcodings;
  if (!Array.isArray(transcodings) || transcodings.length === 0) {
    throw new Error("This SoundCloud track has no playable audio stream");
  }

  // SoundCloud retired its older MP3/Opus transcodings. Prefer the current AAC HLS stream.
  const selected = transcodings.find((item) =>
    item?.format?.protocol === "hls" && /aac/i.test(item?.format?.mime_type || ""),
  ) || transcodings.find((item) => item?.format?.protocol === "hls") || transcodings[0];
  if (!selected?.url) throw new Error("SoundCloud did not provide a media URL");

  const clientId = await scdl.getClientID();
  const endpoint = new URL(selected.url);
  endpoint.searchParams.set("client_id", clientId);
  const mediaResponse = await scdl.axios.get(endpoint.toString(), { timeout: 20000 });
  const streamUrl = mediaResponse.data?.url;
  if (!streamUrl) throw new Error("SoundCloud did not resolve the audio stream URL");
  return streamUrl;
}

function startMp3Stream(req, res, id) {
  let ffmpeg = null;
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    console.error("SoundCloud MP3 stream failed:", error?.message || error);
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGKILL");
    if (!res.headersSent) json(res, 502, { err: -1, msg: "Unable to create MP3 audio stream" });
    else res.destroy();
  };

  getStreamUrl(id).then((streamUrl) => {
    if (settled || res.destroyed) return;
    if (!ffmpegPath) throw new Error("FFmpeg binary is unavailable");
    ffmpeg = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-user_agent", "Mozilla/5.0 OttoRobot/1.0",
      "-i", streamUrl,
      "-vn", "-ac", "1", "-ar", "24000",
      "-codec:a", "libmp3lame", "-b:a", "64k",
      "-f", "mp3", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on("data", (chunk) => console.error("ffmpeg:", chunk.toString().trim()));
    ffmpeg.on("error", fail);
    ffmpeg.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        console.error("SoundCloud MP3 stream failed: FFmpeg exited with code " + code);
        if (!res.headersSent) json(res, 502, { err: -1, msg: "Unable to transcode SoundCloud audio" });
        else res.destroy();
        return;
      }
      if (!res.headersSent) {
        json(res, 502, { err: -1, msg: "SoundCloud returned an empty audio stream" });
        return;
      }
      if (!res.writableEnded) res.end();
    });
    res.writeHead(200, {
      "content-type": "audio/mpeg",
      "cache-control": "no-store",
      "content-disposition": "inline; filename=music.mp3",
      "x-content-type-options": "nosniff",
    });
    res.on("close", () => {
      if (!res.writableEnded && !settled && ffmpeg && !ffmpeg.killed) {
        settled = true;
        ffmpeg.kill("SIGKILL");
      }
    });
  }).catch(fail);
}

async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    const path = requestUrl.pathname;

    if (path === "/" || path === "/health" || path === "/api/health") {
      return json(res, 200, { ok: true, provider: "soundcloud-mp3-experimental" });
    }
    if (!isAuthorized(req)) return json(res, 401, { err: -1, msg: "Unauthorized" });

    if (path === "/api/search") {
      const query = (requestUrl.searchParams.get("q") || "").trim();
      if (!query) return json(res, 400, { err: -1, msg: "Missing query q" });
      const songs = await searchTracks(query);
      return json(res, 200, { err: 0, msg: "Success", data: { songs } });
    }

    if (path === "/api/info-song") {
      const info = await getTrackInfo(requestUrl.searchParams.get("id"));
      const song = trackToSong(info);
      if (!song) return json(res, 404, { err: -1, msg: "SoundCloud track not found" });
      return json(res, 200, { err: 0, msg: "Success", data: song });
    }

    if (path === "/api/song") {
      const id = trackId(requestUrl.searchParams.get("id"));
      const streamUrl = publicBaseUrl(req) + "/api/audio?id=" + encodeURIComponent(id);
      return json(res, 200, { err: 0, msg: "Success", data: { "128": streamUrl } });
    }

    if (path === "/api/audio") {
      startMp3Stream(req, res, requestUrl.searchParams.get("id"));
      return;
    }

    if (path === "/api/song/stream") {
      const id = trackId(requestUrl.searchParams.get("id"));
      const streamUrl = publicBaseUrl(req) + "/api/audio?id=" + encodeURIComponent(id);
      res.writeHead(302, { location: streamUrl, "cache-control": "no-store" });
      return res.end();
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("API request failed:", error?.message || error);
    return json(res, 502, { err: -1, msg: error?.message || "Internal error" });
  }
}

module.exports = handler;

if (require.main === module) {
  http.createServer(handler).listen(PORT, "0.0.0.0", () => {
    console.log("SoundCloud MP3 API listening on port " + PORT);
  });
}
