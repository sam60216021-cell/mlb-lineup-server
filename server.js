'use strict';

/**
 * server.js — MLB Lineup Server
 *
 * Runs on port 3001 (set PORT env var to override).
 *
 * Endpoints:
 *   GET /                  health check
 *   GET /mlb/lineups       today's batting orders + probable pitchers
 *   GET /mlb/schedule      today's games (alias view of the same data)
 *   GET /mlb/roster        flat player list for today's games
 *
 * Scrape schedule:
 *   • On startup  — if no file exists for today
 *   • Daily 9 AM Eastern  (probable pitchers + any early lineups)
 *   • Daily 1 PM Eastern  (catches most afternoon/evening confirmed lineups)
 *   • Daily 5 PM Eastern  (final sweep before first pitches)
 *
 * In The Pitcher app → Settings, set the server URL to:
 *   http://<your-mac-ip>:3001
 */

const express  = require('express');
const axios    = require('axios');
const cron     = require('node-cron');
const winston  = require('winston');
const fs       = require('fs');
const path     = require('path');
const { scrapeAndSave } = require('./scraper');

// ─── Logger ───────────────────────────────────────────────────────────────────

const LOGS_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp}  ${level.toUpperCase().padEnd(5)}  ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(LOGS_DIR, 'server.log'),
      maxsize:  5 * 1024 * 1024,   // 5 MB
      maxFiles: 3,
    }),
    new winston.transports.File({
      filename: path.join(LOGS_DIR, 'error.log'),
      level:    'error',
      maxsize:  2 * 1024 * 1024,
      maxFiles: 2,
    }),
  ],
});

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT     = parseInt(process.env.PORT || '3001', 10);
const DATA_DIR = path.join(__dirname, 'data', 'lineups');

// The Odds API (pitcher strikeout props). Set ODDS_API_KEY in the environment.
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_BASE    = 'https://api.the-odds-api.com/v4';
const BOOKMAKERS   = 'fanduel,draftkings,fanatics,prizepicks';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Today's date in Eastern time (YYYY-MM-DD). */
function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Validate a ?date= query param (YYYY-MM-DD). Returns null when invalid. */
function validDateParam(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** Load the lineup JSON for an arbitrary date. Returns null if the file doesn't exist. */
function loadDate(date) {
  const filePath = path.join(DATA_DIR, `${date}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    logger.error(`Failed to parse lineup file ${date}: ${err.message}`);
    return null;
  }
}

/** Load today's lineup JSON from disk. Returns null if the file doesn't exist. */
function loadToday() {
  return loadDate(todayET());
}

/**
 * Resolve the data for a request: `?date=` if provided (files are scraped on a
 * daily cadence, so historical/future dates serve whatever is on disk), else
 * today. If today has no data yet, an on-demand scrape is attempted.
 */
async function resolveRequestData(req) {
  const date = validDateParam(req.query.date) || todayET();
  let raw = loadDate(date);
  if (!raw && date === todayET()) {
    logger.info(`[api] No data for today — on-demand scrape`);
    raw = await runScrape('on-demand');
  }
  return { date, raw };
}

// ─── Scrape runner ────────────────────────────────────────────────────────────

async function runScrape(reason = 'scheduled') {
  const date = todayET();
  logger.info(`[scrape] Starting (${reason}) for ${date}`);
  try {
    const data = await scrapeAndSave(date);
    logger.info(
      `[scrape] Done — ${data.game_count} games | ` +
      `${data.games_official} official | ${data.games_projected} projected`
    );
    return data;
  } catch (err) {
    logger.error(`[scrape] Failed: ${err.stack || err.message}`);
    return null;
  }
}

// ─── Cron jobs ────────────────────────────────────────────────────────────────
// All times are Eastern. Probable pitchers are posted days in advance; confirmed
// lineups typically arrive 1–3 hours before first pitch (4–7 PM ET for evening games).

//  9:00 AM ET — morning run: grabs schedule + probable pitchers
cron.schedule('0 9 * * *', () => runScrape('9 AM cron'), { timezone: 'America/New_York' });

//  1:00 PM ET — afternoon run: picks up any early lineups
cron.schedule('0 13 * * *', () => runScrape('1 PM cron'), { timezone: 'America/New_York' });

//  5:00 PM ET — evening run: most confirmed batting orders are posted by now
cron.schedule('0 17 * * *', () => runScrape('5 PM cron'), { timezone: 'America/New_York' });

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');

// GET /
app.get('/', (_req, res) => {
  const raw = loadToday();
  res.json({
    status:        'ok',
    server:        'MLB Lineup Server',
    date:          todayET(),
    last_updated:  raw?.last_updated ?? null,
    game_count:    raw?.game_count   ?? 0,
    games_official: raw?.games_official ?? 0,
    endpoints: {
      lineups:  'GET /mlb/lineups',
      schedule: 'GET /mlb/schedule',
      roster:   'GET /mlb/roster',
      odds:     'GET /mlb/odds/strikeouts',
    },
    odds_configured: Boolean(ODDS_API_KEY),
    cron: ['9:00 AM ET', '1:00 PM ET', '5:00 PM ET'],
  });
});

// GET /mlb/lineups (?date=YYYY-MM-DD optional)
// Shape expected by LocalDataService.swift:
//   { date, games: [{ game_id, away, home, start_time, away_batting_order, home_batting_order, ... }] }
app.get('/mlb/lineups', async (req, res) => {
  const { date, raw } = await resolveRequestData(req);
  if (!raw) {
    return res.status(404).json({
      error: `Lineups not yet available for ${date}. The server scrapes at 9 AM, 1 PM, and 5 PM ET.`,
    });
  }

  const games = (raw.games || []).map(g => ({
    game_id:            g.game_id,
    away:               g.away,
    home:               g.home,
    start_time:         g.start_time,
    away_pitcher:       g.away_pitcher,
    home_pitcher:       g.home_pitcher,
    away_batting_order: g.away_batting_order,
    home_batting_order: g.home_batting_order,
    lineups_official:   g.lineups_official,
    lineups_projected:  g.lineups_projected,
    venue:              g.venue,
    status:             g.status,
  }));

  res.json({
    as_of:      raw.last_updated,
    date:       raw.date,
    game_count: raw.game_count,
    games,
  });
});

// GET /mlb/schedule (?date=YYYY-MM-DD optional)
// Alias — same data in a schedule-centric shape.
app.get('/mlb/schedule', async (req, res) => {
  const { date, raw } = await resolveRequestData(req);
  if (!raw) {
    return res.status(404).json({
      error: `Schedule not yet available for ${date}.`,
    });
  }

  const games = (raw.games || []).map(g => ({
    game_id:      g.game_id,
    away:         g.away,
    home:         g.home,
    start_time:   g.start_time,
    status:       g.status,
    venue:        g.venue,
    away_pitcher: g.away_pitcher,
    home_pitcher: g.home_pitcher,
  }));

  res.json({
    as_of:      new Date().toISOString(),
    date:       raw.date,
    game_count: raw.game_count,
    games,
  });
});

// GET /mlb/roster (?date=YYYY-MM-DD optional)
// Flat player list expected by LocalDataService.swift:
//   { players: [{ player_id, name, team, pos }] }
app.get('/mlb/roster', async (req, res) => {
  const { date, raw } = await resolveRequestData(req);
  if (!raw) {
    return res.status(404).json({ error: `Roster not yet available for ${date}.` });
  }

  const seen    = new Set();
  const players = [];

  for (const g of (raw.games || [])) {
    // Batters
    for (const p of [...(g.away_batting_order || []), ...(g.home_batting_order || [])]) {
      if (!p.name) continue;
      const key = p.player_id != null ? String(p.player_id) : `name:${p.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      players.push({
        player_id: p.player_id != null ? String(p.player_id) : null,
        name:      p.name,
        team:      p.team,
        pos:       p.position || null,
      });
    }

    // Starting pitchers
    for (const [name, team] of [[g.away_pitcher, g.away], [g.home_pitcher, g.home]]) {
      if (!name || name === 'TBD') continue;
      const key = `P:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      players.push({ player_id: null, name, team, pos: 'P' });
    }
  }

  res.json({ players });
});

// ─── /mlb/odds/strikeouts ─────────────────────────────────────────────────────
// Pitcher strikeout props from The Odds API for every MLB game today.
// Cached in memory for 10 minutes so the iOS app gets fast responses without
// burning extra API credits. Requires ODDS_API_KEY in the environment.
//
// Response shape:
//   {
//     "cached_at": "2026-08-18T00:00:00.000Z",
//     "props": [
//       { "player_name": "Gerrit Cole", "market": "pitcher_strikeouts",
//         "bookmakers": [ { "key": "fanduel", "title": "FanDuel",
//                           "line": 6.5, "over_odds": -115, "under_odds": -110 } ] }
//     ]
//   }
const STRIKEOUTS_TTL = 10 * 60 * 1000;   // 10 minutes
let strikeoutsCache = null;              // { data, ts }

function isFresh(entry, ttl) {
  return entry !== null && (Date.now() - entry.ts) < ttl;
}

app.get('/mlb/odds/strikeouts', async (_req, res) => {
  if (isFresh(strikeoutsCache, STRIKEOUTS_TTL)) {
    return res.json(strikeoutsCache.data);
  }

  if (!ODDS_API_KEY) {
    return res.status(503).json({ error: 'ODDS_API_KEY not configured on server' });
  }

  try {
    // 1. Fetch all MLB events for today
    const eventsResp = await axios.get(`${ODDS_BASE}/sports/baseball_mlb/events`, {
      params: { apiKey: ODDS_API_KEY },
      timeout: 15000,
    });
    const events = eventsResp.data || [];
    logger.info(`[strikeouts] fetching odds for ${events.length} events`);

    // 2. Fetch pitcher_strikeouts odds for every event in parallel.
    //    propMap: playerName → { player_name, market, bookmakers[] }
    const propMap = new Map();

    await Promise.allSettled(
      events.map(async (event) => {
        try {
          const oddsResp = await axios.get(
            `${ODDS_BASE}/sports/baseball_mlb/events/${event.id}/odds`,
            {
              params: {
                apiKey:     ODDS_API_KEY,
                regions:    'us',
                markets:    'pitcher_strikeouts',
                bookmakers: BOOKMAKERS,
                oddsFormat: 'american',
              },
              timeout: 15000,
            }
          );

          for (const bookmaker of oddsResp.data.bookmakers || []) {
            for (const market of bookmaker.markets || []) {
              if (market.key !== 'pitcher_strikeouts') continue;

              // Group Over + Under outcomes by player name
              const byPlayer = new Map();
              for (const outcome of market.outcomes || []) {
                const playerName = outcome.description;
                if (!playerName) continue;
                if (!byPlayer.has(playerName)) {
                  byPlayer.set(playerName, { over: null, under: null });
                }
                const sides = byPlayer.get(playerName);
                if (outcome.name === 'Over') {
                  sides.over = { price: outcome.price, point: outcome.point };
                } else if (outcome.name === 'Under') {
                  sides.under = { price: outcome.price, point: outcome.point };
                }
              }

              for (const [playerName, sides] of byPlayer) {
                if (!propMap.has(playerName)) {
                  propMap.set(playerName, {
                    player_name: playerName,
                    market:      'pitcher_strikeouts',
                    bookmakers:  [],
                  });
                }
                const entry = propMap.get(playerName);
                const line  = sides.over?.point ?? sides.under?.point ?? 0;
                entry.bookmakers.push({
                  key:        bookmaker.key,
                  title:      bookmaker.title,
                  line,
                  over_odds:  sides.over  ? sides.over.price  : null,
                  under_odds: sides.under ? sides.under.price : null,
                });
              }
            }
          }
        } catch (e) {
          // A single-event failure is non-fatal — skip and continue
          logger.warn(`[strikeouts] event ${event.id} odds failed: ${e.message}`);
        }
      })
    );

    const props   = Array.from(propMap.values());
    const payload = { cached_at: new Date().toISOString(), props };

    strikeoutsCache = { data: payload, ts: Date.now() };
    logger.info(`[strikeouts] cached ${props.length} pitcher props`);
    res.json(payload);
  } catch (err) {
    logger.error(`[strikeouts] error: ${err.message}`);
    // Serve stale cache on network failure
    if (strikeoutsCache) {
      return res.json(strikeoutsCache.data);
    }
    res.status(502).json({ error: 'Failed to fetch strikeout odds', detail: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`MLB Lineup Server listening on port ${PORT}`);
  logger.info(`Cron: 9:00 AM, 1:00 PM, 5:00 PM ET daily`);

  const existing = loadToday();
  if (!existing) {
    logger.info('No lineup data for today — running initial scrape on startup');
    runScrape('startup');
  } else {
    logger.info(
      `Lineup data already present: ${existing.game_count} games, ` +
      `last updated ${existing.last_updated}`
    );
  }
});

// Unhandled rejection safety net
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});
