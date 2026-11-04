require("dotenv").config();

const axios = require("axios");
const cors = require("cors");
const express = require("express");
const path = require("path");
const { Markup, Telegraf } = require("telegraf");

const app = express();
const port = Number(process.env.PORT) || 3000;
const allowedOrigins = (process.env.FRONTEND_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const requestCounts = new Map();
const geocodeCache = new Map();
const rateLimitWindowMs = 60_000;
const rateLimitMax = 10;
const geocodeCacheMs = 10 * 60_000;
const overpassUrl = "https://overpass-api.de/api/interpreter";
const nominatimBaseUrl = "https://nominatim.openstreetmap.org";
let nextNominatimRequestAt = 0;
let nominatimQueue = Promise.resolve();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json({ limit: "16kb" }));

function rateLimit(req, res, next) {
  const now = Date.now();
  const current = requestCounts.get(req.ip);

  if (!current || now - current.startedAt >= rateLimitWindowMs) {
    requestCounts.set(req.ip, { startedAt: now, count: 1 });
    return next();
  }

  current.count += 1;
  if (current.count > rateLimitMax) {
    res.set("Retry-After", String(Math.ceil((rateLimitWindowMs - (now - current.startedAt)) / 1000)));
    return res.status(429).json({ error: "Too many requests. Try again in a minute." });
  }

  return next();
}

function requestNominatim(url) {
  const request = nominatimQueue.then(async () => {
    const delay = Math.max(0, nextNominatimRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    nextNominatimRequestAt = Date.now() + 1_100;

    return axios.get(url, {
      timeout: 15_000,
      headers: {
        "User-Agent": process.env.NOMINATIM_CONTACT_EMAIL
          ? `JomDecide/1.0 (${process.env.NOMINATIM_CONTACT_EMAIL})`
          : "JomDecide/1.0",
        "Referer": process.env.MINI_APP_URL || "http://localhost:3000"
      }
    });
  });

  nominatimQueue = request.then(() => undefined, () => undefined);
  return request;
}

function validateCoordinates(coordinates) {
  return coordinates
    && Number.isFinite(coordinates.latitude)
    && Number.isFinite(coordinates.longitude)
    && Math.abs(coordinates.latitude) <= 90
    && Math.abs(coordinates.longitude) <= 180;
}

async function getLocation(location, coordinates) {
  const cacheKey = coordinates
    ? `reverse:${coordinates.latitude.toFixed(4)},${coordinates.longitude.toFixed(4)}`
    : `search:${location.trim().toLowerCase()}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let response;
  if (coordinates) {
    const url = new URL(`${nominatimBaseUrl}/reverse`);
    url.searchParams.set("lat", coordinates.latitude);
    url.searchParams.set("lon", coordinates.longitude);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    if (process.env.NOMINATIM_CONTACT_EMAIL) {
      url.searchParams.set("email", process.env.NOMINATIM_CONTACT_EMAIL);
    }
    response = await requestNominatim(url);
    if (response.data.address?.country_code?.toLowerCase() !== "my") {
      const error = new Error("Use a location in Malaysia.");
      error.status = 400;
      throw error;
    }

    const value = { latitude: Number(response.data.lat), longitude: Number(response.data.lon) };
    geocodeCache.set(cacheKey, { value, expiresAt: Date.now() + geocodeCacheMs });
    return value;
  }

  const url = new URL(`${nominatimBaseUrl}/search`);
  const searchLocation = location.trim().replace(/\bgeorgetown\b/gi, "George Town");
  const query = /\bmalaysia\b/i.test(searchLocation) ? searchLocation : `${searchLocation}, Malaysia`;
  url.searchParams.set("q", query);
  url.searchParams.set("countrycodes", "my");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  if (process.env.NOMINATIM_CONTACT_EMAIL) {
    url.searchParams.set("email", process.env.NOMINATIM_CONTACT_EMAIL);
  }
  response = await requestNominatim(url);
  const result = response.data.find((item) => item.address?.country_code?.toLowerCase() === "my");

  if (!result) {
    const error = new Error("No Malaysian location found. Check the area name and try again.");
    error.status = 400;
    throw error;
  }

  const value = { latitude: Number(result.lat), longitude: Number(result.lon) };
  geocodeCache.set(cacheKey, { value, expiresAt: Date.now() + geocodeCacheMs });
  return value;
}

function buildOverpassQuery(type, latitude, longitude) {
  const center = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  const clauses = type === "food"
    ? [`nwr["amenity"~"^(restaurant|cafe|fast_food|food_court)$"](around:3000,${center});`]
    : [
      `nwr["leisure"="park"](around:3000,${center});`,
      `nwr["amenity"="amusement_arcade"](around:3000,${center});`,
      `nwr["shop"="mall"](around:3000,${center});`
    ];

  return `[out:json][timeout:25];(${clauses.join("")});out center tags;`;
}

function getPlaceCategory(tags) {
  if (tags.amenity === "restaurant") return tags.cuisine ? `Restaurant · ${tags.cuisine}` : "Restaurant";
  if (tags.amenity === "cafe") return "Cafe";
  if (tags.amenity === "fast_food") return tags.cuisine ? `Fast food · ${tags.cuisine}` : "Fast food";
  if (tags.amenity === "food_court") return "Food court";
  if (tags.amenity === "amusement_arcade") return "Arcade";
  if (tags.leisure === "park") return "Park";
  if (tags.shop === "mall") return "Shopping mall";
  return "Place";
}

function toPlace(element, fallbackArea) {
  const latitude = Number(element.lat ?? element.center?.lat);
  const longitude = Number(element.lon ?? element.center?.lon);
  const tags = element.tags || {};
  const name = tags.name || tags["name:en"] || tags.operator;

  if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const area = tags["addr:suburb"]
    || tags["addr:city"]
    || tags["addr:town"]
    || tags["addr:village"]
    || fallbackArea;
  const query = `${latitude},${longitude}`;

  return {
    name,
    category: getPlaceCategory(tags),
    area,
    latitude,
    longitude,
    googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${query}`,
    wazeUrl: `https://waze.com/ul?ll=${query}&navigate=yes`
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/decide", rateLimit, async (req, res) => {
  const { location, coordinates, type } = req.body || {};
  const hasCoordinates = validateCoordinates(coordinates);

  if ((!hasCoordinates && (typeof location !== "string" || !location.trim() || location.length > 120))
    || (coordinates && !hasCoordinates)
    || !["food", "hangout"].includes(type)) {
    return res.status(400).json({ error: "Provide a Malaysian area or valid coordinates and select food or hangout." });
  }

  let service = "Nominatim";
  try {
    const center = await getLocation(location, hasCoordinates ? coordinates : null);
    service = "Overpass";
    const query = buildOverpassQuery(type, center.latitude, center.longitude);
    const response = await axios.post(overpassUrl, new URLSearchParams({ data: query }).toString(), {
      timeout: 35_000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "JomDecide/1.0"
      }
    });
    const places = (response.data.elements || [])
      .map((element) => toPlace(element, location?.trim() || "Near you"))
      .filter(Boolean);

    if (!places.length) {
      return res.status(404).json({ error: "No named places found within 3 km. Try another area or category." });
    }

    return res.json({ place: places[Math.floor(Math.random() * places.length)] });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ error: error.message });
    }

    const upstreamStatus = error.response?.status;
    console.error(`${service} request failed:`, upstreamStatus || error.message);
    return res.status(502).json({
      error: "OpenStreetMap search is temporarily unavailable. Try again shortly."
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

async function start() {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, () => resolve(instance));
    instance.once("error", reject);
  });

  console.log(`Jom Decide server listening on port ${port}`);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const miniAppUrl = process.env.MINI_APP_URL;

  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN is not set; Telegram bot is disabled.");
    return server;
  }

  if (!miniAppUrl || !miniAppUrl.startsWith("https://")) {
    server.close();
    throw new Error("Set MINI_APP_URL to the Mini App's public HTTPS URL.");
  }

  const bot = new Telegraf(token);
  bot.start((ctx) => ctx.reply(
    "Ready to decide? Tap below to open Jom Decide.",
    Markup.inlineKeyboard([Markup.button.webApp("🎲 Open Jom Decide", miniAppUrl)])
  ));
  bot.catch((error) => {
    console.error("Telegram bot error:", error.message);
  });

  await bot.launch();
  console.log("Telegram bot is running with long polling.");

  const stop = (signal) => {
    console.log(`Received ${signal}; stopping bot and server.`);
    bot.stop(signal);
    server.close();
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  return server;
}

start().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exitCode = 1;
});
