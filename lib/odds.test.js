// lib/odds.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOddsEvents, findTeamPrice, findTotalsLine } from './odds.js';

const ODDS_FIXTURE = [
  {
    id: 'evt123',
    home_team: 'Boston Red Sox',
    away_team: 'New York Yankees',
    commence_time: '2026-07-22T23:05:00Z',
    bookmakers: [
      {
        key: 'draftkings',
        markets: [
          {
            key: 'h2h',
            outcomes: [
              { name: 'Boston Red Sox', price: 1.85 },
              { name: 'New York Yankees', price: 2.05 },
            ],
          },
          {
            key: 'totals',
            outcomes: [
              { name: 'Over', price: 1.91, point: 8.5 },
              { name: 'Under', price: 1.91, point: 8.5 },
            ],
          },
        ],
      },
    ],
  },
];

test('parseOddsEvents: extracts event info with h2h and totals markets', () => {
  const events = parseOddsEvents(ODDS_FIXTURE);
  assert.equal(events.length, 1);
  assert.equal(events[0].homeTeam, 'Boston Red Sox');
  assert.equal(events[0].h2h.bookmaker, 'draftkings');
  assert.equal(events[0].totals.bookmaker, 'draftkings');
});

test('findTeamPrice: returns the decimal price for a team', () => {
  const events = parseOddsEvents(ODDS_FIXTURE);
  assert.equal(findTeamPrice(events[0].h2h, 'Boston Red Sox'), 1.85);
});

test('findTeamPrice: returns null when the team is not found', () => {
  const events = parseOddsEvents(ODDS_FIXTURE);
  assert.equal(findTeamPrice(events[0].h2h, 'Los Angeles Dodgers'), null);
});

test('findTotalsLine: returns price and point for a side', () => {
  const events = parseOddsEvents(ODDS_FIXTURE);
  assert.deepEqual(findTotalsLine(events[0].totals, 'Over'), { price: 1.91, point: 8.5 });
});
