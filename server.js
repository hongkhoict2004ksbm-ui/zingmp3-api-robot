"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const PORT = Number(process.env.PORT || 5555);
const API_TOKEN = process.env.API_TOKEN || "";
const ZING_BASE_URL = process.env.ZING_BASE_URL || "https://zingmp3.vn";
const ZING_VERSION = process.env.ZING_VERSION || "1.6.34";
const ZING_API_KEY = process.env.ZING_API_KEY || "";
const ZING_SECRET_KEY = process.env.ZING_SECRET_KEY || "";

if (!API_TOKEN || !ZING_API_KEY || !ZING_SECRET_KEY) {
  throw new Error("API_TOKEN, ZING_API_KEY and ZING_SECRET_KEY must be configured");
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";
let cachedCookie = "";
let cookieExpiresAt = 0;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function secureTokenEqual(provided) {
  if (typeof provided !== "string") return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(API_TOKEN);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function signature(path, ctime, id = "") {
  const fields = id
    ? `ctime=${ctime}id=${id}version=${ZING_VERSION}`
    : `ctime=${ctime}version=${ZING_VERSION}`;
  const digest = crypto.createHmac("sha512", ZING_SECRET_KEY)
    .update(path + sha256(fields), "utf8")
    .digest("hex");
  return digest;
}

async function getCookie() {
  if (cachedCookie && Date.now() < cookieExpiresAt) return cachedCookie;

  const response = await fetch(ZING_BASE_URL, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  const cookies = setCookies
    .map((item) => item.split(";")[0])
    .filter(Boolean);
  if (!response.ok || cookies.length === 0) {
    throw new Error(`Could not obtain Zing session cookie (HTTP ${response.status})`);
  }

  cachedCookie = cookies.join("; ");
  cookieExpiresAt = Date.now() + 4 * 60 * 1000;
  return cachedCookie;
}

async function zingRequest(path, params, idForSignature = "") {
  const ctime = String(Math.floor(Date.now() / 1000));
  const url = new URL(path, ZING_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("ctime", ctime);
  url.searchParams.set("version", ZING_VERSION);
  url.searchParams.set("sig", signature(path, ctime, idForSignature));
  url.searchParams.set("apiKey", ZING_API_KEY);

  const cookie = await getCookie();
  const response = await fetch(url, {
    headers: {
      cookie,
      referer: `${ZING_BASE_URL}/`,
      "user-agent": USER_AGENT,
      accept: "application/json, text/plain, */*",
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Zing returned non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok || body.err !== 0) {
    throw new Error(`Zing API error (HTTP ${response.status}, err=${body.err ?? "unknown"})`);
  }
  return body;
}

async function searchSongs(query) {
  const path = "/api/v2/search/multi";
  const body = await zingRequest(path, { q: query });
  const source = body.data?.songs;
  const songs = Array.isArray(source) ? source : (source?.items || []);
  return { ...body, data: { ...body.data, songs } };
}

async function getSong(id) {
  const path = "/api/v2/song/get/streaming";
  return zingRequest(path, { id }, id);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && requestUrl.pathname === "/health") {
    return json(res, 200, { ok: true });
  }

  if (!secureTokenEqual(req.headers["x-api-key"])) {
    return json(res, 401, { error: "Unauthorized" });
  }

  try {
    if (req.method === "GET" && requestUrl.pathname === "/api/search") {
      const query = (requestUrl.searchParams.get("q") || "").trim();
      if (!query || query.length > 160) {
        return json(res, 400, { error: "q is required (max 160 characters)" });
      }
      return json(res, 200, await searchSongs(query));
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/song") {
      const id = requestUrl.searchParams.get("id") || "";
      if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) {
        return json(res, 400, { error: "Invalid song id" });
      }
      return json(res, 200, await getSong(id));
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/song/stream") {
      const id = requestUrl.searchParams.get("id") || "";
      if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) {
        return json(res, 400, { error: "Invalid song id" });
      }
      const result = await getSong(id);
      const streamUrl = result.data?.[requestUrl.searchParams.get("quality") || "128"];
      if (typeof streamUrl !== "string" || !/^https:\/\//i.test(streamUrl)) {
        return json(res, 404, { error: "No stream URL available for requested quality" });
      }
      res.writeHead(302, { location: streamUrl, "cache-control": "no-store" });
      return res.end();
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Zing API request failed:", error.message);
    return json(res, 502, { error: "Zing MP3 request failed" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Otto Zing MP3 API listening on port ${PORT}`);
});
