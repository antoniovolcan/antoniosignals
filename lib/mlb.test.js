// lib/mlb.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleGames, mapGameStatus } from './mlb.js';
import { parseLastTenRecord, computeRecentEra } from './mlb.js';

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
  });
  assert.equal(games[1].status, 'postponed');
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
