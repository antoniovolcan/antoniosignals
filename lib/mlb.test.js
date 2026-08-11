// lib/mlb.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleGames, mapGameStatus } from './mlb.js';
import { computeRecentEra, extractPitcherName, countRealStarts } from './mlb.js';
import { extractBattingAvgAndPA, parseRoster } from './mlb.js';
import { extractPitchHand } from './mlb.js';
import { extractFinalScore, extractPlayerBattingHits } from './mlb.js';
import { extractFirstFiveInningsScore } from './mlb.js';
import { computeSeasonEra, extractRunsPerGame } from './mlb.js';
import { findMostRecentFinalGamePk, extractStartingLineup } from './mlb.js';
import { extractOpsFromHittingStats } from './mlb.js';
import { extractPowerContactProfile } from './mlb.js';
import { filterGameLogBefore, computeWinPctFromSchedule } from './mlb.js';
import { extractPlateAppearances, extractNotableHits } from './mlb.js';
import { computeCareerEraBeforeSeason } from './mlb.js';
import { mlbDateToday, addDaysToDateString } from './mlb.js';

test('mlbDateToday: returns a YYYY-MM-DD string', () => {
  const today = mlbDateToday();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
});

test('addDaysToDateString: subtracts a day, including across a month boundary', () => {
  assert.equal(addDaysToDateString('2026-08-01', -1), '2026-07-31');
});

test('addDaysToDateString: adds a day, including across a year boundary', () => {
  assert.equal(addDaysToDateString('2025-12-31', 1), '2026-01-01');
});

const SCHEDULE_FIXTURE = {
  dates: [
    {
      games: [
        {
          gamePk: 745804,
          status: { detailedState: 'Scheduled' },
          teams: {
            home: { team: { id: 111, name: 'Boston Red Sox' } },
            away: { team: { id: 147, name: 'New York Yankees' } },
          },
        },
        {
          gamePk: 745805,
          status: { detailedState: 'Postponed' },
          teams: {
            home: { team: { id: 158, name: 'Milwaukee Brewers' } },
            away: { team: { id: 112, name: 'Chicago Cubs' } },
          },
        },
      ],
    },
  ],
};

test('mapGameStatus: maps known MLB statuses to internal statuses', () => {
  assert.equal(mapGameStatus('Scheduled'), 'scheduled');
  assert.equal(mapGameStatus('In Progress'), 'live');
  assert.equal(mapGameStatus('Final'), 'final');
  assert.equal(mapGameStatus('Postponed'), 'postponed');
});

test('mapGameStatus: unknown status defaults to scheduled', () => {
  assert.equal(mapGameStatus('Something Weird'), 'scheduled');
});

test('parseScheduleGames: extracts games with team names, ids, and mapped status', () => {
  const games = parseScheduleGames(SCHEDULE_FIXTURE);
  assert.equal(games.length, 2);
  assert.deepEqual(games[0], {
    gamePk: 745804,
    status: 'scheduled',
    homeTeam: 'Boston Red Sox',
    awayTeam: 'New York Yankees',
    homeTeamId: 111,
    awayTeamId: 147,
    homeProbablePitcherId: null,
    awayProbablePitcherId: null,
  });
  assert.equal(games[1].status, 'postponed');
});

test('parseScheduleGames: extracts probable pitcher ids when announced', () => {
  const games = parseScheduleGames({
    dates: [{
      games: [{
        gamePk: 999999,
        status: { detailedState: 'Scheduled' },
        teams: {
          home: { team: { id: 111, name: 'Boston Red Sox' }, probablePitcher: { id: 123456 } },
          away: { team: { id: 147, name: 'New York Yankees' }, probablePitcher: { id: 654321 } },
        },
      }],
    }],
  });
  assert.equal(games[0].homeProbablePitcherId, 123456);
  assert.equal(games[0].awayProbablePitcherId, 654321);
});

test('parseScheduleGames: returns empty array when there are no games', () => {
  assert.deepEqual(parseScheduleGames({ dates: [] }), []);
});

const GAMELOG_FIXTURE = {
  stats: [
    {
      splits: [
        { date: '2024-04-01', stat: { earnedRuns: 5, inningsPitched: '4.0' } },
        { date: '2024-04-08', stat: { earnedRuns: 2, inningsPitched: '6.0' } },
        { date: '2024-04-15', stat: { earnedRuns: 3, inningsPitched: '5.1' } },
        { date: '2024-04-22', stat: { earnedRuns: 1, inningsPitched: '7.0' } },
      ],
    },
  ],
};

test('computeRecentEra: computes ERA from the last N starts by date, not array order', () => {
  const era = computeRecentEra(GAMELOG_FIXTURE, 3);
  // Most recent 3 by date: 04-08 (2 ER, 6.0 IP), 04-15 (3 ER, 5.1 IP), 04-22 (1 ER, 7.0 IP)
  // earned runs = 6, outs = 18+16+21 = 55 -> IP = 18.333
  // The oldest start (04-01, 5 ER, 4.0 IP) must be excluded.
  assert.ok(Math.abs(era - (6 * 9) / (55 / 3)) < 0.01);
});

test('computeRecentEra: falls back to league average when no innings pitched', () => {
  const era = computeRecentEra({ stats: [{ splits: [] }] }, 5);
  assert.equal(era, 4.00);
});

test('computeRecentEra: clamps a small-sample blowup (real bug found: 1 bad early-season outing gave ERA ~65)', () => {
  const era = computeRecentEra({ stats: [{ splits: [{ date: '2025-04-01', stat: { earnedRuns: 8, inningsPitched: '1.0' } }] }] }, 5);
  // raw would be 8*9/1 = 72 -- must be clamped to the 0.4x-2.2x league-average band (1.6-8.8)
  assert.equal(era, 8.8);
});

test('computeRecentEra: clamps a small-sample scoreless outing up to a realistic floor', () => {
  const era = computeRecentEra({ stats: [{ splits: [{ date: '2025-04-01', stat: { earnedRuns: 0, inningsPitched: '9.0' } }] }] }, 5);
  // raw would be 0 -- must be clamped up to the 0.4x-2.2x league-average band's floor (1.6)
  assert.equal(era, 1.6);
});

test('extractPitcherName: returns the pitcher name from the most recent split', () => {
  const name = extractPitcherName({
    stats: [{ splits: [{ date: '2024-04-22', player: { id: 1, fullName: 'Gerrit Cole' } }] }],
  });
  assert.equal(name, 'Gerrit Cole');
});

test('extractPitcherName: returns null when there are no splits', () => {
  const name = extractPitcherName({ stats: [{ splits: [] }] });
  assert.equal(name, null);
});

test('countRealStarts: counts only appearances with gamesStarted===1, excluding relief outings', () => {
  const gameLog = {
    stats: [{
      splits: [
        { stat: { gamesStarted: 1 } },
        { stat: { gamesStarted: 0 } }, // relief appearance, shouldn't count
        { stat: { gamesStarted: 1 } },
        { stat: { gamesStarted: 1 } },
      ],
    }],
  };
  assert.equal(countRealStarts(gameLog), 3);
});

test('countRealStarts: returns 0 for an empty-splits gameLog', () => {
  assert.equal(countRealStarts({ stats: [{ splits: [] }] }), 0);
});

const BATTER_STATS_FIXTURE = {
  stats: [
    {
      splits: [
        { stat: { avg: '.278', gamesPlayed: 80, plateAppearances: 344 } },
      ],
    },
  ],
};

test('extractBattingAvgAndPA: extracts avg and PA-per-game from season stats', () => {
  const { avg, paPerGame } = extractBattingAvgAndPA(BATTER_STATS_FIXTURE);
  assert.ok(Math.abs(avg - 0.278) < 1e-9);
  assert.ok(Math.abs(paPerGame - 4.3) < 0.01);
});

test('extractBattingAvgAndPA: falls back to league-average defaults when no data', () => {
  const { avg, paPerGame } = extractBattingAvgAndPA({ stats: [{ splits: [] }] });
  assert.equal(avg, 0.240);
  assert.equal(paPerGame, 4.3);
});

test('extractBattingAvgAndPA: treats MLB\'s ".---" (no at-bats) avg as the default, not NaN', () => {
  const { avg } = extractBattingAvgAndPA({
    stats: [{ splits: [{ stat: { avg: '.---', gamesPlayed: 3, plateAppearances: 5 } }] }],
  });
  assert.equal(avg, 0.240);
});

test('extractBattingAvgAndPA: treats gamesPlayed of 0 as no real data', () => {
  const { avg, paPerGame } = extractBattingAvgAndPA({
    stats: [{ splits: [{ stat: { avg: '.300', gamesPlayed: 0, plateAppearances: 0 } }] }],
  });
  assert.equal(avg, 0.240);
  assert.equal(paPerGame, 4.3);
});

test('extractBattingAvgAndPA: clamps a small-sample 1.000 average (real case found: 1-for-1 -> projected 5 hits/game)', () => {
  const { avg } = extractBattingAvgAndPA({
    stats: [{ splits: [{ stat: { avg: '1.000', gamesPlayed: 1, plateAppearances: 5 } }] }],
  });
  assert.equal(avg, 0.380);
});

test('extractBattingAvgAndPA: clamps a small-sample .000 average', () => {
  const { avg } = extractBattingAvgAndPA({
    stats: [{ splits: [{ stat: { avg: '.000', gamesPlayed: 2, plateAppearances: 4 } }] }],
  });
  assert.equal(avg, 0.150);
});

const ROSTER_FIXTURE = {
  roster: [
    { person: { id: 592450, fullName: 'Aaron Judge' }, position: { abbreviation: 'RF' } },
    { person: { id: 665742, fullName: 'Juan Soto' }, position: { abbreviation: 'RF' } },
  ],
};

test('parseRoster: extracts player id and name for each roster entry', () => {
  const roster = parseRoster(ROSTER_FIXTURE);
  assert.deepEqual(roster, [
    { personId: 592450, fullName: 'Aaron Judge' },
    { personId: 665742, fullName: 'Juan Soto' },
  ]);
});

test('extractPitchHand: returns the pitch hand code for a left-handed pitcher', () => {
  const hand = extractPitchHand({
    people: [{ id: 605483, fullName: 'Blake Snell', pitchHand: { code: 'L', description: 'Left' } }],
  });
  assert.equal(hand, 'L');
});

test('extractPitchHand: returns the pitch hand code for a right-handed pitcher', () => {
  const hand = extractPitchHand({
    people: [{ id: 543037, fullName: 'Gerrit Cole', pitchHand: { code: 'R', description: 'Right' } }],
  });
  assert.equal(hand, 'R');
});

test('extractPitchHand: returns null when person data is missing', () => {
  const hand = extractPitchHand({ people: [] });
  assert.equal(hand, null);
});

test('extractPowerContactProfile: computes HR rate and AVG from a hitting stats split', () => {
  const profile = extractPowerContactProfile({
    stats: [{ splits: [{ stat: { homeRuns: 40, plateAppearances: 600, avg: '.280' } }] }],
  });
  assert.ok(Math.abs(profile.hrRate - 40 / 600) < 1e-9);
  assert.equal(profile.avg, 0.280);
});

test('extractPowerContactProfile: falls back to league averages when no split data', () => {
  const profile = extractPowerContactProfile({ stats: [{ splits: [] }] });
  assert.equal(profile.hrRate, 0.032);
  assert.equal(profile.avg, 0.248);
});

test('extractPowerContactProfile: falls back to league average HR rate when plate appearances is zero', () => {
  const profile = extractPowerContactProfile({
    stats: [{ splits: [{ stat: { homeRuns: 0, plateAppearances: 0, avg: '.000' } }] }],
  });
  assert.equal(profile.hrRate, 0.032);
});

const LINESCORE_FIXTURE = {
  teams: { home: { runs: 5 }, away: { runs: 3 } },
};

test('extractFinalScore: extracts home and away runs', () => {
  const score = extractFinalScore(LINESCORE_FIXTURE);
  assert.deepEqual(score, { home: 5, away: 3 });
});

test('extractFinalScore: returns null when runs are missing (game not final)', () => {
  const score = extractFinalScore({ teams: { home: {}, away: {} } });
  assert.equal(score, null);
});

const FULL_LINESCORE_FIXTURE = {
  innings: [
    { num: 1, home: { runs: 0 }, away: { runs: 4 } },
    { num: 2, home: { runs: 0 }, away: { runs: 0 } },
    { num: 3, home: { runs: 1 }, away: { runs: 0 } },
    { num: 4, home: { runs: 0 }, away: { runs: 0 } },
    { num: 5, home: { runs: 2 }, away: { runs: 1 } },
    { num: 6, home: { runs: 0 }, away: { runs: 3 } },
    { num: 7, home: { runs: 0 }, away: { runs: 0 } },
    { num: 8, home: { runs: 1 }, away: { runs: 0 } },
    { num: 9, home: { runs: 0 }, away: { runs: 0 } },
  ],
};

test('extractFirstFiveInningsScore: sums only innings 1-5, ignoring later innings', () => {
  const score = extractFirstFiveInningsScore(FULL_LINESCORE_FIXTURE);
  assert.deepEqual(score, { home: 3, away: 5 });
});

test('extractFirstFiveInningsScore: returns null when fewer than 5 innings are on record', () => {
  const score = extractFirstFiveInningsScore({ innings: FULL_LINESCORE_FIXTURE.innings.slice(0, 3) });
  assert.equal(score, null);
});

const BOXSCORE_FIXTURE = {
  teams: {
    home: {
      players: {
        ID624585: { person: { id: 624585, fullName: 'Jorge Soler' }, stats: { batting: { hits: 2, atBats: 4 }, pitching: {} } },
      },
    },
    away: {
      players: {
        ID678906: { person: { id: 678906, fullName: 'Kai-Wei Teng' }, stats: { batting: {}, pitching: { strikeOuts: 6, inningsPitched: '6.0' } } },
      },
    },
  },
};

test('extractPlayerBattingHits: finds a batter in the home team and returns their hits', () => {
  const hits = extractPlayerBattingHits(BOXSCORE_FIXTURE, 624585);
  assert.equal(hits, 2);
});

test('extractPlayerBattingHits: returns null for a player not in the boxscore', () => {
  const hits = extractPlayerBattingHits(BOXSCORE_FIXTURE, 999999);
  assert.equal(hits, null);
});

test('extractPlayerBattingHits: returns null for a player who has no batting stats (e.g. a pure pitcher)', () => {
  const hits = extractPlayerBattingHits(BOXSCORE_FIXTURE, 678906);
  assert.equal(hits, null);
});

test('computeSeasonEra: computes ERA across every start in the gameLog, not just the most recent N', () => {
  const seasonEra = computeSeasonEra(GAMELOG_FIXTURE);
  // all 4 splits: earned runs = 5+2+3+1=11, outs = 12+18+16+21=67 -> IP = 67/3
  assert.ok(Math.abs(seasonEra - (11 * 9) / (67 / 3)) < 0.01);
});

const TEAM_SEASON_HITTING_FIXTURE = {
  stats: [{ splits: [{ stat: { runs: 815, gamesPlayed: 162 }, team: { id: 147, name: 'New York Yankees' } }] }],
};

test('extractRunsPerGame: computes runs per game from season totals', () => {
  const rpg = extractRunsPerGame(TEAM_SEASON_HITTING_FIXTURE);
  assert.ok(Math.abs(rpg - 815 / 162) < 1e-9);
});

test('extractRunsPerGame: falls back to league average when no split data', () => {
  const rpg = extractRunsPerGame({ stats: [{ splits: [] }] });
  assert.equal(rpg, 4.5);
});

test('extractRunsPerGame: falls back to league average when games played is zero', () => {
  const rpg = extractRunsPerGame({ stats: [{ splits: [{ stat: { runs: 0, gamesPlayed: 0 } }] }] });
  assert.equal(rpg, 4.5);
});

const RECENT_HITTING_FIXTURE = {
  stats: [{ splits: [{ stat: { runs: 33, gamesPlayed: 10 }, team: { id: 147 } }] }],
};

test('extractRunsPerGame: also works on a byDateRange (recent) hitting response, same shape as season', () => {
  const rpg = extractRunsPerGame(RECENT_HITTING_FIXTURE);
  assert.ok(Math.abs(rpg - 33 / 10) < 1e-9);
});

const OPS_HITTING_FIXTURE = {
  stats: [{ splits: [{ stat: { ops: '.847' } }] }],
};

test('extractOpsFromHittingStats: parses a real OPS value from the stat object', () => {
  const ops = extractOpsFromHittingStats(OPS_HITTING_FIXTURE);
  assert.ok(Math.abs(ops - 0.847) < 1e-9);
});

test('extractOpsFromHittingStats: falls back to league average when ops is the MLB "no at-bats" placeholder', () => {
  const ops = extractOpsFromHittingStats({ stats: [{ splits: [{ stat: { ops: '.---' } }] }] });
  assert.equal(ops, 0.720);
});

test('extractOpsFromHittingStats: falls back to league average when there is no split data', () => {
  const ops = extractOpsFromHittingStats({ stats: [{ splits: [] }] });
  assert.equal(ops, 0.720);
});

const TEAM_SCHEDULE_FIXTURE = {
  dates: [
    { date: '2026-07-20', games: [{ gamePk: 111, status: { detailedState: 'Final' } }] },
    { date: '2026-07-21', games: [{ gamePk: 222, status: { detailedState: 'Postponed' } }] },
    { date: '2026-07-22', games: [{ gamePk: 333, status: { detailedState: 'Final' } }] },
  ],
};

test('findMostRecentFinalGamePk: returns the gamePk of the latest Final game by date', () => {
  const gamePk = findMostRecentFinalGamePk(TEAM_SCHEDULE_FIXTURE);
  assert.equal(gamePk, 333);
});

test('findMostRecentFinalGamePk: skips non-Final games', () => {
  const gamePk = findMostRecentFinalGamePk({
    dates: [{ date: '2026-07-22', games: [{ gamePk: 999, status: { detailedState: 'Postponed' } }] }],
  });
  assert.equal(gamePk, null);
});

test('findMostRecentFinalGamePk: returns null when there are no games', () => {
  const gamePk = findMostRecentFinalGamePk({ dates: [] });
  assert.equal(gamePk, null);
});

const LINEUP_BOXSCORE_FIXTURE = {
  teams: {
    home: {
      team: { id: 147 },
      battingOrder: [1001, 1002],
      players: {
        ID1001: { person: { id: 1001, fullName: 'Player One' } },
        ID1002: { person: { id: 1002, fullName: 'Player Two' } },
      },
    },
    away: {
      team: { id: 121 },
      battingOrder: [2001],
      players: {
        ID2001: { person: { id: 2001, fullName: 'Player Three' } },
      },
    },
  },
};

test('extractStartingLineup: extracts the home team lineup in batting order', () => {
  const lineup = extractStartingLineup(LINEUP_BOXSCORE_FIXTURE, 147);
  assert.deepEqual(lineup, [
    { personId: 1001, fullName: 'Player One' },
    { personId: 1002, fullName: 'Player Two' },
  ]);
});

test('extractStartingLineup: extracts the away team lineup when teamId matches away', () => {
  const lineup = extractStartingLineup(LINEUP_BOXSCORE_FIXTURE, 121);
  assert.deepEqual(lineup, [{ personId: 2001, fullName: 'Player Three' }]);
});

test('extractStartingLineup: returns an empty array when teamId matches neither side', () => {
  const lineup = extractStartingLineup(LINEUP_BOXSCORE_FIXTURE, 999);
  assert.deepEqual(lineup, []);
});

test('extractStartingLineup: returns an empty array when battingOrder is missing', () => {
  const lineup = extractStartingLineup({ teams: { home: { team: { id: 147 } }, away: { team: { id: 121 } } } }, 147);
  assert.deepEqual(lineup, []);
});

const GAME_LOG_FIXTURE = {
  stats: [{
    splits: [
      { date: '2026-05-10', stat: { strikeOuts: 6, inningsPitched: '6.0', gamesStarted: 1 } },
      { date: '2026-05-15', stat: { strikeOuts: 8, inningsPitched: '7.0', gamesStarted: 1 } },
      { date: '2026-05-20', stat: { strikeOuts: 4, inningsPitched: '5.0', gamesStarted: 1 } },
    ],
  }],
};

test('filterGameLogBefore: keeps only splits strictly before the cutoff date', () => {
  const filtered = filterGameLogBefore(GAME_LOG_FIXTURE, '2026-05-15');
  assert.equal(filtered.stats[0].splits.length, 1);
  assert.equal(filtered.stats[0].splits[0].date, '2026-05-10');
});

test('filterGameLogBefore: an empty cutoff-inclusive range returns no splits', () => {
  const filtered = filterGameLogBefore(GAME_LOG_FIXTURE, '2026-05-01');
  assert.equal(filtered.stats[0].splits.length, 0);
});

test('filterGameLogBefore: handles a missing stats/splits shape gracefully', () => {
  const filtered = filterGameLogBefore({}, '2026-05-15');
  assert.deepEqual(filtered.stats[0].splits, []);
});

const WIN_PCT_SCHEDULE_FIXTURE = {
  dates: [
    { date: '2026-05-01', games: [{ status: { detailedState: 'Final' }, teams: { home: { team: { id: 147 }, isWinner: true }, away: { team: { id: 121 }, isWinner: false } } }] },
    { date: '2026-05-02', games: [{ status: { detailedState: 'Final' }, teams: { home: { team: { id: 121 }, isWinner: true }, away: { team: { id: 147 }, isWinner: false } } }] },
    { date: '2026-05-03', games: [{ status: { detailedState: 'Scheduled' }, teams: { home: { team: { id: 147 } }, away: { team: { id: 121 } } } }] },
  ],
};

test('computeWinPctFromSchedule: computes win pct from the team\'s finished games only, ignoring unfinished ones', () => {
  const pct = computeWinPctFromSchedule(WIN_PCT_SCHEDULE_FIXTURE, 147);
  assert.ok(Math.abs(pct - 0.5) < 1e-9);
});

test('computeWinPctFromSchedule: with lastN, caps at the most recent N finished games', () => {
  const dates = [];
  for (let i = 1; i <= 20; i++) {
    const day = String(i).padStart(2, '0');
    dates.push({ date: `2026-05-${day}`, games: [{ status: { detailedState: 'Final' }, teams: { home: { team: { id: 147 }, isWinner: i <= 5 }, away: { team: { id: 121 }, isWinner: i > 5 } } }] });
  }
  const pct = computeWinPctFromSchedule({ dates }, 147, { lastN: 15 });
  // most recent 15 games are days 6-20, of which team 147 (home, isWinner: i<=5) won none
  assert.equal(pct, 0);
});

test('computeWinPctFromSchedule: without lastN, counts every finished game (season-to-date)', () => {
  const dates = [];
  for (let i = 1; i <= 20; i++) {
    const day = String(i).padStart(2, '0');
    dates.push({ date: `2026-05-${day}`, games: [{ status: { detailedState: 'Final' }, teams: { home: { team: { id: 147 }, isWinner: i <= 5 }, away: { team: { id: 121 }, isWinner: i > 5 } } }] });
  }
  const pct = computeWinPctFromSchedule({ dates }, 147);
  // all 20 games count; team 147 (home) won days 1-5 only -> 5/20
  assert.ok(Math.abs(pct - 0.25) < 1e-9);
});

test('computeWinPctFromSchedule: returns 0.5 default when there are no finished games for the team', () => {
  const pct = computeWinPctFromSchedule({ dates: [] }, 147);
  assert.equal(pct, 0.5);
});

const PLAY_BY_PLAY_FIXTURE = {
  allPlays: [
    {
      result: { type: 'atBat', event: 'Home Run', description: 'Brandon Lowe homers.', rbi: 2 },
      about: { inning: 3, halfInning: 'bottom' },
      matchup: { batter: { id: 1, fullName: 'Brandon Lowe' }, batSide: { code: 'L' }, pitcher: { id: 9, fullName: 'Aaron Nola' }, pitchHand: { code: 'R' } },
    },
    {
      result: { type: 'atBat', event: 'Strikeout', description: 'Player X strikes out.', rbi: 0 },
      about: { inning: 4, halfInning: 'top' },
      matchup: { batter: { id: 2, fullName: 'Player X' }, batSide: { code: 'R' }, pitcher: { id: 10, fullName: 'Some Pitcher' }, pitchHand: { code: 'L' } },
    },
    {
      result: { type: 'stolenBase', event: 'Stolen Base', description: 'Runner steals second.' },
      about: { inning: 4, halfInning: 'top' },
      matchup: { batter: { id: 3, fullName: 'Player Y' }, pitcher: { id: 10, fullName: 'Some Pitcher' } },
    },
    {
      result: { type: 'atBat', event: 'Double', description: 'Player Z doubles.', rbi: 1 },
      about: { inning: 5, halfInning: 'bottom' },
      matchup: { batter: { id: 4, fullName: 'Player Z' }, batSide: { code: 'R' }, pitcher: { id: 9, fullName: 'Aaron Nola' }, pitchHand: { code: 'R' } },
    },
  ],
};

test('extractPlateAppearances: extracts only at-bat plays with a batter and pitcher, ignoring non-at-bat events like stolen bases', () => {
  const pas = extractPlateAppearances(PLAY_BY_PLAY_FIXTURE);
  assert.equal(pas.length, 3);
  assert.equal(pas[0].batterName, 'Brandon Lowe');
  assert.equal(pas[0].event, 'Home Run');
  assert.equal(pas[0].pitchHand, 'R');
  assert.equal(pas[0].inning, 3);
});

test('extractPlateAppearances: handles a response with no plays', () => {
  assert.deepEqual(extractPlateAppearances({}), []);
});

test('extractNotableHits: keeps only Single/Double/Triple/Home Run events', () => {
  const pas = extractPlateAppearances(PLAY_BY_PLAY_FIXTURE);
  const notable = extractNotableHits(pas);
  assert.equal(notable.length, 2);
  assert.deepEqual(notable.map(n => n.event), ['Home Run', 'Double']);
});

const YEAR_BY_YEAR_PITCHING_FIXTURE = {
  stats: [{
    splits: [
      { season: '2022', gameType: 'R', team: { id: 147, name: 'New York Yankees' }, stat: { earnedRuns: 30, inningsPitched: '90.0', strikeOuts: 95 } },
      // 2023: traded mid-season — two team-specific splits plus the combined one. Only the
      // combined split (no `team`) should be counted, or innings/ER/K get double-counted.
      { season: '2023', gameType: 'R', team: { id: 147, name: 'New York Yankees' }, stat: { earnedRuns: 20, inningsPitched: '60.0', strikeOuts: 65 } },
      { season: '2023', gameType: 'R', team: { id: 111, name: 'Boston Red Sox' }, stat: { earnedRuns: 15, inningsPitched: '50.0', strikeOuts: 55 } },
      { season: '2023', gameType: 'R', stat: { earnedRuns: 35, inningsPitched: '110.0', strikeOuts: 120 } },
      { season: '2024', gameType: 'S', team: { id: 111, name: 'Boston Red Sox' }, stat: { earnedRuns: 99, inningsPitched: '5.0', strikeOuts: 3 } }, // spring training, must be ignored
      { season: '2025', gameType: 'R', team: { id: 111, name: 'Boston Red Sox' }, stat: { earnedRuns: 40, inningsPitched: '120.0', strikeOuts: 130 } }, // current season, must be excluded
    ],
  }],
};

test('computeCareerEraBeforeSeason: sums earned runs and innings across prior regular seasons', () => {
  // 2022 (30 ER, 90 IP) + 2023 combined (35 ER, 110 IP) = 65 ER, 200 IP -> 65*9/200 = 2.925
  const era = computeCareerEraBeforeSeason(YEAR_BY_YEAR_PITCHING_FIXTURE, 2025);
  assert.ok(Math.abs(era - 2.925) < 1e-9);
});

test('computeCareerEraBeforeSeason: deduplicates a mid-season trade using only the combined split', () => {
  const eraUpTo2024 = computeCareerEraBeforeSeason(YEAR_BY_YEAR_PITCHING_FIXTURE, 2024);
  // If the two team-specific 2023 splits were double-counted alongside the combined split,
  // this would come out far lower than the correct 2.925 (from the previous test, same seasons).
  assert.ok(Math.abs(eraUpTo2024 - 2.925) < 1e-9);
});

test('computeCareerEraBeforeSeason: ignores non-regular-season game types', () => {
  // Confirmed by the fact that including the 2024 spring-training split (99 ER / 5 IP) would
  // massively inflate the ERA if it weren't filtered out.
  const era = computeCareerEraBeforeSeason(YEAR_BY_YEAR_PITCHING_FIXTURE, 2025);
  assert.ok(era < 10);
});

test('computeCareerEraBeforeSeason: excludes the season under analysis and any future season', () => {
  const era = computeCareerEraBeforeSeason(YEAR_BY_YEAR_PITCHING_FIXTURE, 2025);
  const eraIncludingCurrent = (30 + 35 + 40) * 9 / (90 + 110 + 120);
  assert.notEqual(Math.round(era * 1000), Math.round(eraIncludingCurrent * 1000));
});

test('computeCareerEraBeforeSeason: returns null when there are no qualifying prior seasons', () => {
  assert.equal(computeCareerEraBeforeSeason(YEAR_BY_YEAR_PITCHING_FIXTURE, 2022), null);
  assert.equal(computeCareerEraBeforeSeason({ stats: [{ splits: [] }] }, 2025), null);
});

