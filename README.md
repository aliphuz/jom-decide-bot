# Jom Decide

Telegram Bot and mobile-first Mini App for Malaysian places, coin tosses, custom choices, and day plans. Place discovery uses OpenStreetMap services; no Google API key or credit card is required.

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

5. To test Telegram locally, expose the server over HTTPS. Set `MINI_APP_URL` to that HTTPS URL and restart the server. Send `/start` to the bot.

The backend serves the frontend from `public`. It also serves `/api/decide`. The Telegram bot uses long polling; run one backend instance per bot token.

## Configure the bot

1. Open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Follow the prompts and copy the new token to `TELEGRAM_BOT_TOKEN`.
3. Set `MINI_APP_URL` to the deployed frontend URL. Telegram Mini Apps require HTTPS.
4. Deploy the backend and send `/start` to the bot. Its **🎲 Open Jom Decide** button opens the Mini App.

If a token was exposed, revoke it in BotFather and replace it before deployment.

## OpenStreetMap services

- Nominatim geocodes typed areas with `countrycodes=my`. GPS coordinates are reverse-geocoded to confirm they are in Malaysia.
- Overpass searches within 3 km. Food includes restaurants, cafes, fast-food venues, and food courts. Hangout includes parks, arcades, and malls.
- The server identifies itself as `JomDecide/1.0`, honors Nominatim's one-request-per-second limit, and caches geocoding results for 10 minutes.
- Add `NOMINATIM_CONTACT_EMAIL` to backend environment variables. Keep one backend instance to preserve the app's Nominatim request pacing.
- Public OSM services have usage limits and may be temporarily unavailable. The app displays an error instead of returning fabricated places.
- OSM data may be incomplete or stale. Halal status, opening hours, ratings, and prices are not verified.

The Mini App credits OpenStreetMap contributors. Navigation links use Google Maps or Waze; they do not require Google API credentials.

## Deploy backend to Render

1. Push the project to GitHub and create a **Web Service** on [Render](https://render.com).
2. Set build command to `npm install` and start command to `npm start`.
3. Add these environment variables:
   - `TELEGRAM_BOT_TOKEN`
   - `MINI_APP_URL` — your Vercel HTTPS URL
   - `FRONTEND_ORIGINS` — exact Vercel origin, such as `https://your-app.vercel.app`
   - `NOMINATIM_CONTACT_EMAIL`
4. Deploy and copy the Render service URL, such as `https://your-backend.onrender.com`.

Review Render's current free-tier limits. Idle free services may sleep and delay the first request.

## Deploy frontend to Vercel

1. Import the project into [Vercel](https://vercel.com).
2. Choose **Other** as framework preset. Leave build command empty and set output directory to `public`.
3. In `public/index.html`, set the API base URL meta tag to your Render URL, without a trailing slash:

   ```html
   <meta name="api-base-url" content="https://your-backend.onrender.com">
   ```

4. Deploy. Set Render's `MINI_APP_URL` to the Vercel HTTPS URL. Set `FRONTEND_ORIGINS` to its exact origin.
5. If you change the Vercel URL, update both Render variables and redeploy the backend.

`npm start` serves the UI and API on one origin for local use or single-service deployment. Leave the API base URL empty in that setup.

## API

`POST /api/decide` accepts a Malaysian area or coordinates and a type:

```json
{
  "location": "Subang Jaya",
  "type": "food"
}
```

Coordinates can replace `location`:

```json
{
  "coordinates": {
    "latitude": 3.056,
    "longitude": 101.585
  },
  "type": "hangout"
}
```

Types: `food`, `hangout`. Success returns exactly one randomly selected place with its name, category, area, coordinates, Google Maps URL, and Waze URL.
