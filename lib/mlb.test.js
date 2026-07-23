// lib/mlb.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleGames, mapGameStatus } from './mlb.js';
import { parseLastTenRecord, computeRecentEra, extractPitcherName } from './mlb.js';
import { extractBattingAvgAndPA, parseRoster } from './mlb.js';
import { extractStrikeoutsPer9 } from './mlb.js';
import { extractPitchHand } from './mlb.js';

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

const STANDINGS_FIXTURE = {
  records: [
    {
      teamRecords: [
        {
          team: { id: 111 },
          records: {
            splitRecords: [
              { type: 'lastTen', wins: 7, losses: 3 },
            ],
          },
        },
      ],
    },
  ],
};

test('parseLastTenRecord: returns win pct for a known team', () => {
  assert.ok(Math.abs(parseLastTenRecord(STANDINGS_FIXTURE, 111) - 0.7) < 1e-9);
});

test('parseLastTenRecord: returns 0.5 for an unknown team', () => {
  assert.equal(parseLastTenRecord(STANDINGS_FIXTURE, 999), 0.5);
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

const PITCHER_SEASON_FIXTURE = {
  stats: [{
    splits: [
      { stat: { strikeOuts: 145, inningsPitched: '104.0' }, player: { id: 605483, fullName: 'Blake Snell' } },
    ],
  }],
};

test('extractStrikeoutsPer9: computes K/9 from season totals', () => {
  const k9 = extractStrikeoutsPer9(PITCHER_SEASON_FIXTURE);
  // 145 K, 104 IP -> (145*9)/104 = 12.548...
  assert.ok(Math.abs(k9 - (145 * 9) / 104) < 0.01);
});

test('extractStrikeoutsPer9: falls back to league average when no split data', () => {
  const k9 = extractStrikeoutsPer9({ stats: [{ splits: [] }] });
  assert.equal(k9, 8.5);
});

test('extractStrikeoutsPer9: falls back to league average when innings pitched is zero', () => {
  const k9 = extractStrikeoutsPer9({
    stats: [{ splits: [{ stat: { strikeOuts: 0, inningsPitched: '0.0' } }] }],
  });
  assert.equal(k9, 8.5);
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
