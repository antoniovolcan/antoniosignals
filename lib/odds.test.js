// lib/odds.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOddsEvents, findTeamPrice, findTotalsLine } from './odds.js';
import { parsePlayerPropOutcomes } from './odds.js';

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

test('parseOddsEvents: with multiple bookmakers, uses the first one offering the market', () => {
  const multiBookmakerEvent = [
    {
      id: 'evt456',
      home_team: 'Los Angeles Dodgers',
      away_team: 'San Francisco Giants',
      commence_time: '2026-07-22T23:05:00Z',
      bookmakers: [
        { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'Los Angeles Dodgers', price: 1.50 }, { name: 'San Francisco Giants', price: 2.80 }] }] },
        { key: 'draftkings', markets: [{ key: 'h2h', outcomes: [{ name: 'Los Angeles Dodgers', price: 1.55 }, { name: 'San Francisco Giants', price: 2.70 }] }] },
      ],
    },
  ];
  const events = parseOddsEvents(multiBookmakerEvent);
  assert.equal(events[0].h2h.bookmaker, 'fanduel');
  assert.equal(events[0].h2h.outcomes[0].price, 1.50);
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

const PROP_EVENT_FIXTURE = {
  bookmakers: [
    {
      key: 'draftkings',
      markets: [
        {
          key: 'batter_hits',
          outcomes: [
            { name: 'Over', description: 'Aaron Judge', price: 1.95, point: 1.5 },
            { name: 'Under', description: 'Aaron Judge', price: 1.87, point: 1.5 },
            { name: 'Over', description: 'Juan Soto', price: 2.10, point: 1.5 },
          ],
        },
      ],
    },
  ],
};

test('parsePlayerPropOutcomes: returns outcomes matching a player name', () => {
  const outcomes = parsePlayerPropOutcomes(PROP_EVENT_FIXTURE, 'batter_hits', 'Aaron Judge');
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].description, 'Aaron Judge');
});

test('parsePlayerPropOutcomes: returns empty array when player has no prop', () => {
  const outcomes = parsePlayerPropOutcomes(PROP_EVENT_FIXTURE, 'batter_hits', 'Someone Else');
  assert.deepEqual(outcomes, []);
});

test('parsePlayerPropOutcomes: returns empty array when market is missing', () => {
  const outcomes = parsePlayerPropOutcomes(PROP_EVENT_FIXTURE, 'pitcher_strikeouts', 'Aaron Judge');
  assert.deepEqual(outcomes, []);
});
