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
const groupSessions = new Map();
const rateLimitWindowMs = 60_000;
const rateLimitMax = 15;
const geocodeCacheMs = 10 * 60_000;
const groupSessionMs = 6 * 60 * 60_000;
const nominatimBaseUrl = "https://nominatim.openstreetmap.org";
const overpassUrls = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];
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
    ? [`nwr["amenity"~"^(restaurant|cafe|fast_food|food_court)$"](around:4000,${center});`]
    : type === "trip"
      ? [
        `nwr["amenity"~"^(restaurant|cafe|fast_food|food_court|marketplace|museum|cinema)$"](around:5000,${center});`,
        `nwr["leisure"~"^(park|garden|water_park)$"](around:5000,${center});`,
        `nwr["tourism"~"^(attraction|museum|gallery|zoo)$"](around:5000,${center});`,
        `nwr["shop"="mall"](around:5000,${center});`
      ]
      : [
        `nwr["leisure"="park"](around:4000,${center});`,
        `nwr["amenity"="amusement_arcade"](around:4000,${center});`,
        `nwr["shop"="mall"](around:4000,${center});`
      ];

  return `[out:json][timeout:20];(${clauses.join("")});out center tags;`;
}

function getPlaceCategory(tags) {
  if (tags.amenity === "restaurant") return tags.cuisine ? `Restaurant · ${tags.cuisine}` : "Restaurant";
  if (tags.amenity === "cafe") return "Cafe";
  if (tags.amenity === "fast_food") return tags.cuisine ? `Fast food · ${tags.cuisine}` : "Fast food";
  if (tags.amenity === "food_court") return "Food court";
  if (tags.amenity === "amusement_arcade") return "Arcade";
  if (tags.amenity === "museum" || tags.tourism === "museum") return "Museum";
  if (tags.amenity === "cinema") return "Cinema";
  if (tags.amenity === "marketplace") return "Market";
  if (tags.leisure === "park" || tags.leisure === "garden") return "Park";
  if (tags.leisure === "water_park") return "Water park";
  if (tags.shop === "mall") return "Shopping mall";
  if (tags.tourism === "attraction") return "Attraction";
  if (tags.tourism === "gallery") return "Gallery";
  if (tags.tourism === "zoo") return "Zoo";
  return "Place";
}

function budgetEstimate(tags) {
  const text = `${tags.amenity || ""} ${tags.cuisine || ""} ${tags.name || ""}`.toLowerCase();
  if (/steak|steamboat|hot.?pot|bbq|barbecue|fine.?dining|seafood|japanese|korean/.test(text)) return 60;
  if (/fast_food|mamak|malay|indian|rice|nasi|food_court/.test(text)) return 12;
  if (tags.amenity === "cafe") return 22;
  if (tags.amenity === "restaurant") return 25;
  return 20;
}

function budgetTier(estimate) {
  if (estimate < 15) return "under15";
  if (estimate <= 30) return "15to30";
  if (estimate >= 50) return "50plus";
  return "other";
}

function openStatus(openingHours) {
  if (!openingHours) return "Hours unknown";
  if (openingHours.trim() === "24/7") return "Open";
  const match = openingHours.trim().match(/^(?:(?:Mo-Su|daily)\s+)?(\d{2}):(\d{2})-(\d{2}):(\d{2})$/i);
  if (!match) return "Hours unknown";

  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  const current = now.getHours() * 60 + now.getMinutes();
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  const isOpen = end < start ? current >= start || current < end : current >= start && current < end;
  return isOpen ? "Open" : "Closed";
}

function isLateNight(tags) {
  const hours = (tags.opening_hours || tags.openingHours || "").toLowerCase();
  if (hours.includes("24/7")) return true;
  return /(?:-|–)\s*(?:00|01|02|03):\d{2}/.test(hours) || /00:00-/.test(hours);
}

function isHalal(tags) {
  return [tags.halal, tags["diet:halal"]]
    .some((value) => ["yes", "only", "permissive"].includes(String(value || "").toLowerCase()));
}

function isPorkFree(tags) {
  return isHalal(tags)
    || ["no", "only"].includes(String(tags["diet:pork"] || tags.pork || "").toLowerCase());
}

function toPlace(element, fallbackArea, center) {
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
  const estimate = budgetEstimate(tags);
  const distanceKm = center
    ? Math.round(haversineKm(center.latitude, center.longitude, latitude, longitude) * 10) / 10
    : null;

  return {
    id: `${element.type || "n"}-${element.id}`,
    name,
    category: getPlaceCategory(tags),
    area,
    latitude,
    longitude,
    budgetEstimate: estimate,
    budgetTier: budgetTier(estimate),
    openStatus: openStatus(tags.opening_hours),
    openingHours: tags.opening_hours || null,
    distanceKm,
    halal: isHalal(tags),
    porkFree: isPorkFree(tags),
    cuisine: tags.cuisine || null,
    googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${query}`,
    wazeUrl: `https://waze.com/ul?ll=${query}&navigate=yes`
  };
}

function haversineKm(latitude1, longitude1, latitude2, longitude2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitude2 - latitude1);
  const longitudeDelta = radians(longitude2 - longitude1);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function filterPlaces(places, filters) {
  return places.filter((place) => {
    if (filters.budget && filters.budget !== "any" && place.budgetTier !== filters.budget) return false;
    if (filters.dietary === "halal" && !place.halal) return false;
    if (filters.dietary === "pork-free" && !place.porkFree) return false;
    const text = `${place.name} ${place.category} ${place.cuisine || ""}`.toLowerCase();

    if (filters.craving === "nasi" && !/food court|rice|nasi|malay|indian|mamak/.test(text)) return false;
    if (filters.craving === "soupy" && !/soup|noodle|ramen|steamboat|hot.?pot|bak kut teh|mee|pho|laksa|tom yum/i.test(text)) return false;
    if (filters.craving === "fast-fried" && !/fast food|fried|burger|chicken|mamak/.test(text)) return false;
    if (filters.craving === "lepak" && !/cafe|coffee|kopitiam|tea/.test(text)) return false;
    if (filters.craving === "late-night" && !isLateNight(place)) return false;
    return true;
  });
}

function validateSearch(body) {
  const { location, coordinates, type } = body || {};
  const hasCoordinates = validateCoordinates(coordinates);
  const validLocation = typeof location === "string" && location.trim().length > 0 && location.length <= 120;
  if ((!hasCoordinates && !validLocation)
    || (location !== undefined && typeof location !== "string")
    || (typeof location === "string" && location.length > 120)
    || (coordinates && !hasCoordinates)
    || !["food", "hangout", "trip"].includes(type)) {
    const error = new Error("Provide a Malaysian area or valid coordinates and select a supported place type.");
    error.status = 400;
    throw error;
  }
  return { location, coordinates: hasCoordinates ? coordinates : null, type };
}

async function searchPlaces({ location, coordinates, type }) {
  const center = await getLocation(location, coordinates);
  const query = buildOverpassQuery(type, center.latitude, center.longitude);
  let lastError;

  for (const endpoint of overpassUrls) {
    try {
      const response = await axios.post(endpoint, new URLSearchParams({ data: query }).toString(), {
        timeout: 25_000,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "JomDecide/1.0"
        }
      });
      const places = (response.data.elements || [])
        .map((element) => toPlace(element, location?.trim() || "Near you", center))
        .filter(Boolean);
      if (!places.length) {
        const error = new Error("No named places found nearby. Try another area or category.");
        error.status = 404;
        throw error;
      }
      return { center, places };
    } catch (error) {
      if (error.status === 404) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("OpenStreetMap search failed.");
}

function validateFilters(body) {
  const filters = {
    budget: body.budget || "any",
    craving: body.craving || "any",
    dietary: body.dietary || "none"
  };
  if (!["any", "under15", "15to30", "50plus"].includes(filters.budget)
    || !["any", "nasi", "soupy", "fast-fried", "lepak", "late-night"].includes(filters.craving)
    || !["none", "halal", "pork-free"].includes(filters.dietary)) {
    const error = new Error("Choose a valid budget, craving, and dietary filter.");
    error.status = 400;
    throw error;
  }
  return filters;
}

function sendApiError(res, error) {
  if (error.status) return res.status(error.status).json({ error: error.message });
  console.error("Place lookup failed:", error.response?.status || error.message);
  return res.status(502).json({ error: "OpenStreetMap search is temporarily unavailable. Try again shortly." });
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/places", rateLimit, async (req, res) => {
  try {
    const search = validateSearch(req.body);
    const filters = validateFilters(req.body || {});
    const { places } = await searchPlaces(search);
    const activeFilters = search.type === "food"
      ? filters
      : { budget: "any", craving: "any", dietary: "none" };
    const filteredPlaces = filterPlaces(places, activeFilters);
    if (!filteredPlaces.length) {
      return res.status(404).json({ error: "No nearby places match those filters. Try a wider budget or another craving." });
    }
    return res.json({ places: filteredPlaces.slice(0, 60) });
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.post("/api/decide", rateLimit, async (req, res) => {
  try {
    const search = validateSearch(req.body);
    const { places } = await searchPlaces(search);
    const place = places[Math.floor(Math.random() * places.length)];
    return res.json({ place });
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.post("/api/trip", rateLimit, async (req, res) => {
  try {
    const search = validateSearch({ ...req.body, type: "trip" });
    const { places } = await searchPlaces(search);
    const stages = [
      { time: "09:00", title: "Morning · Breakfast & Kopitiam", match: /cafe|restaurant|fast food|food court/i },
      { time: "11:30", title: "Midday · Indoor activity / Attraction", match: /museum|cinema|mall|attraction|gallery|zoo|arcade/i },
      { time: "16:00", title: "Late afternoon · Dessert / Chill cafe", match: /cafe|restaurant/i },
      { time: "19:30", title: "Evening · Dinner / Night spot", match: /restaurant|market|food court|cafe/i }
    ];
    const used = new Set();
    const itinerary = stages.map((stage) => {
      const matching = places.filter((place) => stage.match.test(place.category) && !used.has(place.id));
      const available = matching.length ? matching : places.filter((place) => !used.has(place.id));
      const place = available[Math.floor(Math.random() * available.length)] || places[Math.floor(Math.random() * places.length)];
      used.add(place.id);
      return { time: stage.time, title: stage.title, place };
    });
    return res.json({ location: req.body.location || "Near you", stages: itinerary });
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.post("/api/groups", rateLimit, async (req, res) => {
  try {
    const search = validateSearch({ ...req.body, type: "food" });
    const filters = validateFilters(req.body || {});
    const { places } = await searchPlaces(search);
    const candidates = filterPlaces(places, filters);
    if (candidates.length < 4) {
      return res.status(404).json({ error: "Group voting needs 4 matching places. Widen your filters or try another area." });
    }
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
    }
    const id = require("crypto").randomBytes(9).toString("base64url");
    const session = {
      id,
      places: candidates.slice(0, 4),
      votes: new Map(),
      expiresAt: Date.now() + groupSessionMs
    };
    groupSessions.set(id, session);
    const baseUrl = process.env.MINI_APP_URL || req.get("origin") || `http://localhost:${port}`;
    const shareUrl = new URL(baseUrl);
    shareUrl.searchParams.set("group", id);
    return res.status(201).json({ session: serializeGroup(session), shareUrl: shareUrl.toString() });
  } catch (error) {
    return sendApiError(res, error);
  }
});

function serializeGroup(session) {
  const counts = Array(session.places.length).fill(0);
  for (const index of session.votes.values()) counts[index] += 1;
  return {
    id: session.id,
    places: session.places,
    votes: counts,
    totalVotes: session.votes.size,
    expiresAt: session.expiresAt
  };
}

app.get("/api/groups/:id", (req, res) => {
  const session = groupSessions.get(req.params.id);
  if (!session || session.expiresAt <= Date.now()) {
    groupSessions.delete(req.params.id);
    return res.status(404).json({ error: "This group vote expired or does not exist." });
  }
  return res.json({ session: serializeGroup(session) });
});

app.post("/api/groups/:id/votes", rateLimit, (req, res) => {
  const session = groupSessions.get(req.params.id);
  if (!session || session.expiresAt <= Date.now()) {
    groupSessions.delete(req.params.id);
    return res.status(404).json({ error: "This group vote expired or does not exist." });
  }
  const { optionIndex, voterId } = req.body || {};
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= session.places.length
    || typeof voterId !== "string" || !voterId.trim() || voterId.length > 100) {
    return res.status(400).json({ error: "Choose an option to vote." });
  }
  session.votes.set(voterId.trim(), optionIndex);
  return res.json({ session: serializeGroup(session) });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of groupSessions) {
    if (session.expiresAt <= now) groupSessions.delete(id);
  }
  for (const [ip, entry] of requestCounts) {
    if (now - entry.startedAt >= rateLimitWindowMs) requestCounts.delete(ip);
  }
}, 60_000).unref();

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
  const openApp = (ctx) => ctx.reply(
    "Ready to decide? Tap below to open Jom Decide.",
    Markup.inlineKeyboard([Markup.button.webApp("🎲 Open Jom Decide", miniAppUrl)])
  );
  bot.start(openApp);
  bot.help(openApp);
  bot.command("decide", openApp);
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
