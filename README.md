# mlb-lineup-server

Daily MLB lineup server for **The Pitcher MLB Stats** iOS app.
Deployed on Render at `https://mlb-lineup-server-1.onrender.com`.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Health check + endpoint index |
| `GET /mlb/lineups` | Batting orders + probable pitchers (official → Rotowire projected) |
| `GET /mlb/schedule` | Schedule-centric view of the same data |
| `GET /mlb/roster` | Flat player list for today's games |
| `GET /mlb/odds/strikeouts` | Pitcher strikeout props via The Odds API (10-min cache) |

All lineup endpoints accept an optional `?date=YYYY-MM-DD` param (data is scraped
daily; only scraped dates are available).

## Data sources

1. **MLB Stats API** (`statsapi.mlb.com`) — official confirmed lineups (with real
   player IDs) + probable pitchers. Primary source.
2. **Rotowire** (projected lineups fallback) — names resolved back to real MLB
   player IDs via the Stats API team rosters; `player_id` stays `null` only when
   the name can't be resolved unambiguously.
3. **The Odds API** (strikeout props only) — requires `ODDS_API_KEY`.

## Scraping cadence (Eastern time)

- On startup (if no data for today)
- 9:00 AM — probable pitchers + early lineups
- 1:00 PM — most afternoon/evening confirmed lineups
- 5:00 PM — final sweep before first pitch

## Deploy (Render)

1. Push to `main` — Render auto-deploys.
2. In the Render dashboard → **Environment**, set:
   - `ODDS_API_KEY` — your the-odds-api.com key (server-side only; the iOS app
     never needs its own key once it consumes `/mlb/odds/strikeouts`).

## Cold starts

Render free-tier services sleep after ~15 min of inactivity; the first request
afterwards can take ~20–30 s to wake. To keep it warm, point a free uptime
monitor (e.g. UptimeRobot, cron-job.org) at `GET /` every 10 minutes.

## Local development

```bash
npm install
ODDS_API_KEY=xxx npm start   # listens on PORT (default 3001)
```
