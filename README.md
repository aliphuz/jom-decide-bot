# Jom Decide

Telegram Bot and mobile-first Mini App for Malaysian places, group decisions, coin tosses, custom choices, and day plans. Place discovery uses OpenStreetMap services; no Google API key or credit card is required.

## Features

- **Makan / Hangout:** Search by Malaysian area or GPS. Food search supports estimated budgets (below RM15, RM15–RM30, RM50+), craving filters, and Halal or pork-free tags. Reject once for one re-roll; reject again to restore and lock the first pick.
- **Food tournament:** Choose a 4- or 8-place knockout bracket and pick winners round by round.
- **Group vote:** Create a four-place vote and share its link in Telegram. Votes update every five seconds. Sessions expire after six hours and stay in server memory.
- **Trip builder:** Generate four nearby stops at 09:00, 11:30, 16:00, and 19:30.
- **Coin / Custom:** Coin toss, custom wheel, and manual activity shuffle.
- **Result cards:** Estimated spend, available opening-hours status, distance, and Waze / Google Maps links.

## Requirements

- Node.js 18 or newer
- Telegram bot token from [@BotFather](https://t.me/BotFather)

## Run locally

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`. Set your Telegram token and a contact email for Nominatim:

   ```env
   PORT=3000
   TELEGRAM_BOT_TOKEN=your_botfather_token
   MINI_APP_URL=https://your-public-https-url
   FRONTEND_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
   NOMINATIM_CONTACT_EMAIL=you@example.com
   ```

   Keep `.env` private. Do not put bot tokens in frontend files or commit them.

3. Start the server:

   ```sh
   npm start
   ```

4. Open `http://localhost:3000`. Check `http://localhost:3000/api/health`.

5. To test Telegram locally, expose the server over HTTPS. Set `MINI_APP_URL` to that HTTPS URL and restart the server. Send `/start`, `/help`, or `/decide` to the bot.

The backend serves the frontend from `public`. The Telegram bot uses long polling; run one backend instance per bot token. Group vote state is in memory, so a restart clears active votes and multiple backend instances do not share them.

## Configure the bot

1. Open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Follow the prompts and copy the new token to `TELEGRAM_BOT_TOKEN`.
3. Set `MINI_APP_URL` to the deployed frontend URL. Telegram Mini Apps require HTTPS.
4. Deploy the backend and send `/start` to the bot. Its **🎲 Open Jom Decide** button opens the Mini App.

If a token was exposed, revoke it in BotFather and replace it before deployment.

## OpenStreetMap services

- Nominatim geocodes typed areas with `countrycodes=my`. GPS coordinates are reverse-geocoded to confirm they are in Malaysia.
- Overpass searches within 4 km for food and hangouts, and 5 km for trip stops. Failed Overpass requests try public mirrors.
- The server identifies itself as `JomDecide/1.0`, honors Nominatim's one-request-per-second limit, and caches geocoding results for 10 minutes.
- Add `NOMINATIM_CONTACT_EMAIL` to backend environment variables. Keep one backend instance to preserve Nominatim request pacing.
- Public OSM services have usage limits and may be temporarily unavailable. The app displays an error instead of returning fabricated places.
- OSM data may be incomplete or stale. Budget is a category-based estimate, not a quoted menu price. Dietary filters require explicit OSM tags. Opening status is shown only when supported by simple opening-hours data; otherwise it says “Hours unknown.” No rating or certification is verified.

The Mini App credits OpenStreetMap contributors. Navigation links use Google Maps or Waze; they do not require Google API credentials.

## Deploy backend to Render

1. Push the project to GitHub and create a **Web Service** on [Render](https://render.com).
2. Set build command to `npm install` and start command to `npm start`.
3. In **Render → Environment**, add:
   - `TELEGRAM_BOT_TOKEN` — BotFather token; keep secret.
   - `MINI_APP_URL` — Vercel HTTPS URL.
   - `FRONTEND_ORIGINS` — exact Vercel origin, such as `https://your-app.vercel.app`.
   - `NOMINATIM_CONTACT_EMAIL` — contact email for Nominatim.
   - `PORT` is supplied by Render. Do not set it unless required by your host.
4. Deploy and copy the Render service URL, such as `https://your-backend.onrender.com`.

Review Render's current free-tier limits. Idle free services may sleep and delay the first request.

## Deploy frontend to Vercel

1. Import the project into [Vercel](https://vercel.com).
2. Choose **Other** as framework preset. Leave build command empty and set output directory to `public`.
3. This frontend is static HTML, so Vercel does not inject runtime environment variables into browser JavaScript. In `public/index.html`, set the API base URL meta tag to your Render URL, without a trailing slash:

   ```html
   <meta name="api-base-url" content="https://your-backend.onrender.com">
   ```

4. Deploy. Do not put bot tokens or other secrets in Vercel frontend variables. Set Render's `MINI_APP_URL` to the Vercel HTTPS URL and `FRONTEND_ORIGINS` to its exact origin.
5. If you change the Vercel URL, update Render's `MINI_APP_URL` and `FRONTEND_ORIGINS`, then redeploy the backend.

`npm start` serves the UI and API on one origin for local use or single-service deployment. Leave the API base URL empty in that setup.

## API

`POST /api/places` accepts a Malaysian area or coordinates, a type, and optional filters:

```json
{
  "location": "Subang Jaya",
  "type": "food",
  "budget": "under15",
  "craving": "nasi",
  "dietary": "halal"
}
```

Types: `food`, `hangout`. Budgets: `any`, `under15`, `15to30`, `50plus`. Cravings: `any`, `nasi`, `soupy`, `fast-fried`, `lepak`, `late-night`. Dietary filters: `none`, `halal`, `pork-free`.

The response contains up to 60 matching places. `POST /api/decide` remains available for one random place.

Coordinates can replace `location`:

```json
{
  "coordinates": {
    "latitude": 3.056,
    "longitude": 101.585
  },
  "type": "food"
}
```

`POST /api/groups` creates a four-option vote and returns a share URL. `GET /api/groups/:id` returns live tallies. `POST /api/groups/:id/votes` accepts `{ "optionIndex": 0, "voterId": "..." }`; each voter ID can change its vote.

`POST /api/trip` accepts `{ "location": "Ipoh" }` and returns four place suggestions for a day plan.

Place cards include name, category, area, coordinates, estimated budget, opening status, distance, dietary tags, and navigation URLs. Place data and estimates are not endorsements or guarantees.
