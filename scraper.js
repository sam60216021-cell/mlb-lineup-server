'use strict';

/**
 * scraper.js — MLB lineup scraper.
 *
 * Sources (in priority order):
 *   1. MLB Stats API  statsapi.mlb.com — confirmed batting orders + probable pitchers
 *   2. Rotowire       rotowire.com/baseball/daily-lineups.php — projected lineups fallback
 *
 * Output format matches what LocalDataService.swift decodes:
 *   games[].start_time          → Swift .time     (CodingKey `time = "start_time"`)
 *   games[].away_batting_order  → Swift .awayLineup (CodingKey `away_lineup = "away_batting_order"`)
 *   games[].home_batting_order  → Swift .homeLineup (CodingKey `home_lineup = "home_batting_order"`)
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const MLB_API  = 'https://statsapi.mlb.com/api/v1';
const DATA_DIR = path.join(__dirname, 'data', 'lineups');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Rotowire abbreviation → standard MLB abbreviation
const ROTOWIRE_TO_MLB = {
  ARI: 'ARI', ATL: 'ATL', BAL: 'BAL', BOS: 'BOS', CHC: 'CHC',
  CWS: 'CWS', CIN: 'CIN', CLE: 'CLE', COL: 'COL', DET: 'DET',
  HOU: 'HOU', KC:  'KC',  LAA: 'LAA', LAD: 'LAD', MIA: 'MIA',
  MIL: 'MIL', MIN: 'MIN', NYM: 'NYM', NYY: 'NYY', OAK: 'OAK',
  ATH: 'OAK', PHI: 'PHI', PIT: 'PIT', SD:  'SD',  SEA: 'SEA',
  SF:  'SF',  STL: 'STL', TB:  'TB',  TEX: 'TEX', TOR: 'TOR',
  WSH: 'WSH',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a UTC ISO string to a display time in Eastern. e.g. "7:05 PM" */
function toEasternTime(utcStr) {
  try {
    const d = new Date(utcStr);
    return d.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour:     'numeric',
      minute:   '2-digit',
      hour12:   true,
    }).replace(/^0/, '');
  } catch {
    return 'TBD';
  }
}

/** Sort lineup players by battingOrder ascending. */
function sortByOrder(players) {
  return [...players]
    .filter(p => p.id != null)
    .sort((a, b) => (a.battingOrder || 999) - (b.battingOrder || 999));
}

// ─── MLB Stats API ────────────────────────────────────────────────────────────

async function fetchMLBSchedule(date) {
  const { data } = await axios.get(`${MLB_API}/schedule`, {
    params: {
      sportId:  1,
      date,
      hydrate:  'lineups,probablePitcher(note),team,venue',
      language: 'en',
    },
    timeout: 20_000,
    headers: { 'User-Agent': 'mlb-lineup-server/1.0' },
  });
  return data;
}

// ─── Rotowire fallback ────────────────────────────────────────────────────────

/**
 * Scrape Rotowire projected batting orders.
 * Returns { TEAM_ABBR: [{ name, position, source }] } for each team with ≥7 batters.
 */
async function fetchRotowireLineups() {
  const result = {};
  try {
    const { data: html } = await axios.get(
      'https://www.rotowire.com/baseball/daily-lineups.php',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
            + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept:   'text/html,application/xhtml+xml',
          Referer:  'https://www.rotowire.com/',
        },
        timeout: 20_000,
      }
    );

    const $ = cheerio.load(html);

    $('.lineup__box').each((_i, box) => {
      const abbrs = $(box).find('.lineup__abbr');
      if (abbrs.length < 2) return;

      const awayRaw  = $(abbrs.eq(0)).text().trim().toUpperCase();
      const homeRaw  = $(abbrs.eq(1)).text().trim().toUpperCase();
      const awayAbbr = ROTOWIRE_TO_MLB[awayRaw];
      const homeAbbr = ROTOWIRE_TO_MLB[homeRaw];

      const lists = $(box).find('.lineup__main ul.lineup__list');
      if (!lists.length) return;

      const extractPlayers = (ul) => {
        const players = [];
        $(ul).find('li.lineup__player').each((_j, li) => {
          const a    = $(li).find('a[title]');
          const pos  = $(li).find('.lineup__pos').text().trim().toUpperCase();
          const name = a.length ? $(a).attr('title').trim() : $(li).text(' ', { trim: true });
          if (name && name.includes(' ') && name.length > 4) {
            players.push({ name, position: pos, source: 'rotowire_projected' });
          }
        });
        return players;
      };

      // Rotowire marks the visiting team's list with "is-visit"
      const visitUl = lists.filter('.is-visit');
      const homeUl  = lists.not('.is-visit');

      const awayPlayers = extractPlayers(visitUl.length ? visitUl.first() : lists.first());
      const homePlayers = extractPlayers(homeUl.length  ? homeUl.first()  : lists.last());

      if (awayAbbr && awayPlayers.length >= 7) result[awayAbbr] = awayPlayers.slice(0, 9);
      if (homeAbbr && homePlayers.length >= 7) result[homeAbbr] = homePlayers.slice(0, 9);
    });
  } catch (err) {
    // Non-fatal — Rotowire is a fallback only
    console.error(`[scraper] Rotowire fetch failed: ${err.message}`);
  }
  return result;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Scrape lineups for the given date (YYYY-MM-DD), save to disk, and return the data.
 *
 * Batter priority:
 *   1. Official MLB Stats API confirmed lineups (battingOrder set)
 *   2. Rotowire projected batting orders (names only, no player IDs)
 *   3. Empty array — data will be available closer to game time
 */
async function scrapeAndSave(date) {
  const [schedData, rotowire] = await Promise.all([
    fetchMLBSchedule(date),
    fetchRotowireLineups(),
  ]);

  /** @type {Array} */
  const games    = [];
  /** @type {Array} StartingLineup model (iOS) */
  const lineups  = [];
  /** @type {Array} ProbablePitcher model (iOS) */
  const pitchers = [];

  for (const dateEntry of (schedData.dates || [])) {
    for (const g of dateEntry.games) {
      const gameId   = g.gamePk;
      const awayTeam = g.teams?.away?.team?.abbreviation || '';
      const homeTeam = g.teams?.home?.team?.abbreviation || '';
      const venue    = g.venue?.name || '';
      const startTime = toEasternTime(g.gameDate);
      const status   = g.status?.detailedState || '';
      const now      = new Date().toISOString();

      // Probable pitchers
      const awayProbable = g.teams?.away?.probablePitcher || {};
      const homeProbable = g.teams?.home?.probablePitcher || {};

      // Confirmed lineups from the MLB API lineups hydration
      const officialAway = sortByOrder(g.lineups?.awayPlayers || []);
      const officialHome = sortByOrder(g.lineups?.homePlayers || []);
      const awayIsOfficial = officialAway.length > 0;
      const homeIsOfficial = officialHome.length > 0;

      // Build away batting order: official → Rotowire → []
      const awayBattingOrder = awayIsOfficial
        ? officialAway.map(p => ({
            player_id:  p.id,
            name:       p.fullName,
            position:   p.primaryPosition?.abbreviation || '',
            source:     'official',
            team:       awayTeam,
            updated_at: now,
          }))
        : (rotowire[awayTeam] || []).map(p => ({
            player_id:  null,
            name:       p.name,
            position:   p.position,
            source:     'rotowire_projected',
            team:       awayTeam,
            updated_at: now,
          }));

      // Build home batting order: official → Rotowire → []
      const homeBattingOrder = homeIsOfficial
        ? officialHome.map(p => ({
            player_id:  p.id,
            name:       p.fullName,
            position:   p.primaryPosition?.abbreviation || '',
            source:     'official',
            team:       homeTeam,
            updated_at: now,
          }))
        : (rotowire[homeTeam] || []).map(p => ({
            player_id:  null,
            name:       p.name,
            position:   p.position,
            source:     'rotowire_projected',
            team:       homeTeam,
            updated_at: now,
          }));

      // games[] — human-readable, matches server.py /mlb/lineups format
      games.push({
        game_id:             gameId,
        away:                awayTeam,
        home:                homeTeam,
        start_time:          startTime,
        venue,
        status,
        away_pitcher:        awayProbable.fullName || 'TBD',
        home_pitcher:        homeProbable.fullName || 'TBD',
        away_batting_order:  awayBattingOrder,
        home_batting_order:  homeBattingOrder,
        lineups_official:    awayIsOfficial || homeIsOfficial,
        lineups_projected:   (!awayIsOfficial && rotowire[awayTeam]?.length > 0)
                          || (!homeIsOfficial && rotowire[homeTeam]?.length > 0),
      });

      // lineups[] — iOS StartingLineup model
      lineups.push({
        gameId,
        homeTeam,
        awayTeam,
        homeBatterIds:    officialHome.map(p => p.id),
        awayBatterIds:    officialAway.map(p => p.id),
        homeBatterSource: homeIsOfficial ? 'official' : 'projected',
        awayBatterSource: awayIsOfficial ? 'official' : 'projected',
      });

      // pitchers[] — iOS ProbablePitcher model
      pitchers.push({
        gameId,
        homePitcherId:   homeProbable.id   || null,
        homePitcherName: homeProbable.fullName || 'TBD',
        awayPitcherId:   awayProbable.id   || null,
        awayPitcherName: awayProbable.fullName || 'TBD',
      });
    }
  }

  const gamesOfficial  = games.filter(g => g.lineups_official).length;
  const gamesProjected = games.filter(g => g.lineups_projected && !g.lineups_official).length;

  const output = {
    last_updated:       new Date().toISOString(),
    date,
    game_count:         games.length,
    games_with_lineups: gamesOfficial + gamesProjected,
    games_official:     gamesOfficial,
    games_projected:    gamesProjected,
    lineups,
    pitchers,
    games,
  };

  const outPath = path.join(DATA_DIR, `${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  return output;
}

module.exports = { scrapeAndSave };
