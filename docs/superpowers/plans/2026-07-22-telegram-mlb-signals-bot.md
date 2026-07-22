# MLB Telegram Signals Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal Telegram bot that cross-references MLB stats (statsapi.mlb.com) with betting odds (The Odds API) to surface value-bet "signals" (moneyline, totals, player props) with visible reasoning, deliverable both on a schedule (Vercel Cron) and on demand (Telegram commands), backed by Supabase for history and directional backtesting.

**Architecture:** Vercel serverless functions (`api/telegram-webhook.js`, `api/scan.js`) call small single-purpose libs (`lib/mlb.js`, `lib/odds.js`, `lib/signals.js`, `lib/db.js`, `lib/telegram.js`). Each lib splits **pure/testable logic** (parsing, math) from **network calls** (fetch wrappers), so the heuristic engine and API-response parsers are unit tested with Node's built-in test runner, while network glue is verified manually against the real APIs/Telegram/Supabase.

**Tech Stack:** Node.js 18+ (ESM), Vercel serverless functions + Vercel Cron, Supabase (Postgres) via `@supabase/supabase-js`, The Odds API, MLB Stats API, raw Telegram Bot HTTP API (no bot framework dependency), `node --test` + `assert` for unit tests.

---

## Before you start

This plan builds a brand-new project in `C:\Users\anton\OneDrive\Escritorio\MLB`. A git repo already exists there (created during brainstorming) with one commit containing the design spec at `docs/superpowers/specs/2026-07-22-telegram-mlb-signals-bot-design.md`. All paths below are relative to that project root unless stated otherwise.

You will need, before Task 18 (deployment):
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (`/newbot`)
- Your own Telegram numeric chat ID (message [@userinfobot](https://t.me/userinfobot) to get it)
- A The Odds API key (already contracted per the design spec)
- A Supabase project (free tier) — URL + service role key

None of these are needed until Task 2 (Supabase) and Task 12/18 (Telegram/deploy) — earlier tasks are pure logic with no external accounts required.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `vercel.json`
- Create: `README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "mlb-telegram-signals",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test lib/**/*.test.js"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.env
.vercel
```

- [ ] **Step 3: Create `.env.example`**

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ODDS_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
```

- [ ] **Step 4: Create `vercel.json`**

```json
{
  "crons": [
    { "path": "/api/scan", "schedule": "0 16-23 * * *" }
  ]
}
```

Note: `16-23` is UTC and approximates 12pm–7pm ET during EDT (UTC-4). Adjust after deployment if games are being missed outside this window (Task 18 covers verifying this in practice).

- [ ] **Step 5: Create `README.md`**

```markdown
# MLB Telegram Signals Bot

Personal Telegram bot that cross-references MLB stats with betting odds (The Odds API)
to surface value-bet signals. See `docs/superpowers/specs/2026-07-22-telegram-mlb-signals-bot-design.md`
for the full design.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in credentials.
3. Run `npm test` to run the unit test suite (pure logic only, no network/DB needed).
```

- [ ] **Step 6: Install dependencies**

Run: `cd C:\Users\anton\OneDrive\Escritorio\MLB && npm install`
Expected: `node_modules/` created, `package-lock.json` created, no errors.

- [ ] **Step 7: Commit**

```bash
cd C:\Users\anton\OneDrive\Escritorio\MLB
git add package.json package-lock.json .gitignore .env.example vercel.json README.md
git commit -m "chore: scaffold project structure"
```

---

### Task 2: Supabase schema

**Files:**
- Create: `supabase/schema.sql`

- [ ] **Step 1: Write the schema**

```sql
create table games (
  game_pk bigint primary key,
  date date not null,
  home_team text not null,
  away_team text not null,
  status text not null default 'scheduled',
  created_at timestamptz not null default now()
);

create table team_map (
  mlb_team text primary key,
  odds_team text
);

create table player_map (
  mlb_player_id bigint primary key,
  mlb_name text not null,
  odds_name text
);

create table signals (
  id bigserial primary key,
  game_pk bigint references games(game_pk),
  market text not null,
  selection text not null,
  odds_price numeric not null,
  implied_prob numeric not null,
  estimated_prob numeric not null,
  edge numeric not null,
  reasoning text not null,
  sent_at timestamptz not null default now()
);

create table results (
  game_pk bigint primary key references games(game_pk),
  home_score int,
  away_score int,
  final boolean not null default false,
  updated_at timestamptz not null default now()
);

create table config (
  key text primary key,
  value text not null
);

insert into config (key, value) values ('edge_threshold', '0.05');
```

- [ ] **Step 2: Run it against your Supabase project**

Open the Supabase project's SQL Editor (Supabase dashboard → SQL Editor → New query), paste the contents of `supabase/schema.sql`, and run it.
Expected: 6 tables created (`games`, `team_map`, `player_map`, `signals`, `results`, `config`), and `config` has one row (`edge_threshold` = `0.05`). Verify via Table Editor.

- [ ] **Step 3: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: add Supabase schema"
```

---

### Task 3: Signal engine — win probability & log5

**Files:**
- Create: `lib/signals.js`
- Test: `lib/signals.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// lib/signals.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, pitcherFactor, teamWinProbability, log5 } from './signals.js';

test('clamp bounds a value', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(20, 0, 10), 10);
});

test('pitcherFactor: league-average ERA gives factor 1', () => {
  assert.equal(pitcherFactor(4.00, 4.00), 1);
});

test('pitcherFactor: elite ERA gives factor above 1, capped at 1.8', () => {
  assert.ok(pitcherFactor(1.50, 4.00) > 1);
  assert.equal(pitcherFactor(0.10, 4.00), 1.8);
});

test('pitcherFactor: poor ERA gives factor below 1, floored at 0.5', () => {
  assert.ok(pitcherFactor(8.00, 4.00) < 1);
  assert.equal(pitcherFactor(100, 4.00), 0.5);
});

test('teamWinProbability: league-average team at home is above .500', () => {
  const p = teamWinProbability({ last10WinPct: 0.5, startingPitcherEra: 4.00, isHome: true });
  assert.ok(p > 0.5);
});

test('teamWinProbability: league-average team on the road is below .500', () => {
  const p = teamWinProbability({ last10WinPct: 0.5, startingPitcherEra: 4.00, isHome: false });
  assert.ok(p < 0.5);
});

test('log5: two evenly matched .500 teams gives 50%', () => {
  assert.ok(Math.abs(log5(0.5, 0.5) - 0.5) < 1e-9);
});

test('log5: stronger team has higher win probability', () => {
  assert.ok(log5(0.65, 0.45) > 0.5);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/signals.test.js`
Expected: FAIL — `lib/signals.js` does not exist / exports undefined.

- [ ] **Step 3: Implement**

```js
// lib/signals.js
export const LEAGUE_AVG_ERA = 4.00;
export const HOME_FIELD_BONUS = 0.04;

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function pitcherFactor(era, leagueAvgEra = LEAGUE_AVG_ERA) {
  const factor = leagueAvgEra / Math.max(era, 0.1);
  return clamp(factor, 0.5, 1.8);
}

export function teamWinProbability({ last10WinPct, startingPitcherEra, isHome }) {
  const base = 0.5 * pitcherFactor(startingPitcherEra);
  const recentAdj = (last10WinPct - 0.5) * 0.3;
  const homeAdj = isHome ? HOME_FIELD_BONUS : -HOME_FIELD_BONUS;
  return clamp(base + recentAdj + homeAdj, 0.05, 0.95);
}

export function log5(probA, probB) {
  const denom = probA + probB - 2 * probA * probB;
  if (denom === 0) return 0.5;
  return (probA - probA * probB) / denom;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/signals.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/signals.js lib/signals.test.js
git commit -m "feat: add win probability and log5 heuristic"
```

---

### Task 4: Signal engine — moneyline estimate, totals projection, normal CDF

**Files:**
- Modify: `lib/signals.js`
- Modify: `lib/signals.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// append to lib/signals.test.js
import { moneylineEstimate, projectedTotalRuns, normalCdf, overProbability } from './signals.js';

test('moneylineEstimate: home favorite with better pitcher wins more often', () => {
  const p = moneylineEstimate({
    home: { last10WinPct: 0.7, startingPitcherEra: 2.80 },
    away: { last10WinPct: 0.4, startingPitcherEra: 4.80 },
  });
  assert.ok(p > 0.5);
});

test('projectedTotalRuns: two average teams/pitchers project near league average total', () => {
  const total = projectedTotalRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
  });
  assert.ok(Math.abs(total - 9.0) < 0.5);
});

test('normalCdf: at the mean returns 0.5', () => {
  assert.ok(Math.abs(normalCdf(9.0, 9.0, 3.0) - 0.5) < 0.01);
});

test('normalCdf: far below the mean returns near 0', () => {
  assert.ok(normalCdf(0, 9.0, 3.0) < 0.01);
});

test('normalCdf: far above the mean returns near 1', () => {
  assert.ok(normalCdf(30, 9.0, 3.0) > 0.99);
});

test('overProbability: line below projection favors the over', () => {
  const p = overProbability(7.5, 9.0, 3.0);
  assert.ok(p > 0.5);
});

test('overProbability: line above projection favors the under', () => {
  const p = overProbability(11.5, 9.0, 3.0);
  assert.ok(p < 0.5);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/signals.test.js`
Expected: FAIL — `moneylineEstimate`, `projectedTotalRuns`, `normalCdf`, `overProbability` not defined.

- [ ] **Step 3: Implement**

```js
// append to lib/signals.js
export const LEAGUE_AVG_RUNS_PER_GAME = 4.5;

export function moneylineEstimate({ home, away }) {
  const pHome = teamWinProbability({ ...home, isHome: true });
  const pAway = teamWinProbability({ ...away, isHome: false });
  return log5(pHome, pAway);
}

export function projectedTotalRuns({ home, away }) {
  const homeExpected = (home.runsPerGame + LEAGUE_AVG_RUNS_PER_GAME * (away.startingPitcherEra / LEAGUE_AVG_ERA)) / 2;
  const awayExpected = (away.runsPerGame + LEAGUE_AVG_RUNS_PER_GAME * (home.startingPitcherEra / LEAGUE_AVG_ERA)) / 2;
  return homeExpected + awayExpected;
}

// Zelen & Severo rational approximation of the standard normal CDF.
export function normalCdf(x, mean, stdDev) {
  const z = (x - mean) / stdDev;
  const absZ = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * absZ);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const poly = t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  const p = 1 - d * poly;
  return z >= 0 ? p : 1 - p;
}

export function overProbability(line, projectedTotal, stdDev = 3.0) {
  return 1 - normalCdf(line, projectedTotal, stdDev);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/signals.test.js`
Expected: PASS, 15 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/signals.js lib/signals.test.js
git commit -m "feat: add moneyline and totals projection"
```

---

### Task 5: Signal engine — player prop probability (Poisson)

**Files:**
- Modify: `lib/signals.js`
- Modify: `lib/signals.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// append to lib/signals.test.js
import { poissonPmf, poissonCdf, overProbabilityProp } from './signals.js';

test('poissonPmf: P(0 events | lambda=0) is 1', () => {
  assert.equal(poissonPmf(0, 0.0001) > 0.99, true);
});

test('poissonCdf: cumulative probability approaches 1 as k grows', () => {
  assert.ok(poissonCdf(20, 1.2) > 0.999);
});

test('overProbabilityProp: low expected rate against a low line still allows some over probability', () => {
  const p = overProbabilityProp(1.5, 1.2);
  assert.ok(p > 0 && p < 1);
});

test('overProbabilityProp: higher expected rate raises the over probability for the same line', () => {
  const low = overProbabilityProp(1.5, 0.8);
  const high = overProbabilityProp(1.5, 2.0);
  assert.ok(high > low);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/signals.test.js`
Expected: FAIL — `poissonPmf`, `poissonCdf`, `overProbabilityProp` not defined.

- [ ] **Step 3: Implement**

```js
// append to lib/signals.js
function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

export function poissonPmf(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

export function poissonCdf(k, lambda) {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += poissonPmf(i, lambda);
  return sum;
}

// line is a half-integer (e.g. 1.5 hits) -> "over" means >= floor(line) + 1
export function overProbabilityProp(line, expectedRate) {
  const threshold = Math.floor(line);
  return 1 - poissonCdf(threshold, expectedRate);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/signals.test.js`
Expected: PASS, 19 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/signals.js lib/signals.test.js
git commit -m "feat: add Poisson-based player prop probability"
```

---

### Task 6: Signal engine — implied probability, edge, and message formatting

**Files:**
- Modify: `lib/signals.js`
- Modify: `lib/signals.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// append to lib/signals.test.js
import { impliedProbability, edge, isSignal, formatSignalMessage } from './signals.js';

test('impliedProbability: decimal odds of 2.00 implies 50%', () => {
  assert.ok(Math.abs(impliedProbability(2.00) - 0.5) < 1e-9);
});

test('edge: estimated minus implied', () => {
  assert.ok(Math.abs(edge(0.60, 0.50) - 0.10) < 1e-9);
});

test('isSignal: edge above threshold is a signal', () => {
  assert.equal(isSignal(0.613, 0.541, 0.05), true);
});

test('isSignal: edge below threshold is not a signal', () => {
  assert.equal(isSignal(0.55, 0.541, 0.05), false);
});

test('formatSignalMessage: includes matchup, market, odds, edge, and reasoning', () => {
  const msg = formatSignalMessage({
    matchup: 'NYY @ BOS',
    market: 'Moneyline',
    selection: 'BOS gana',
    price: 1.85,
    impliedProb: 0.541,
    estimatedProb: 0.613,
    edgeValue: 0.072,
    reasoning: 'ERA abridor BOS 2.87 (últimos 5) vs NYY.',
  });
  assert.match(msg, /NYY @ BOS/);
  assert.match(msg, /Moneyline: BOS gana/);
  assert.match(msg, /1\.85/);
  assert.match(msg, /54\.1%/);
  assert.match(msg, /61\.3%/);
  assert.match(msg, /\+7\.2%/);
  assert.match(msg, /ERA abridor BOS 2\.87/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/signals.test.js`
Expected: FAIL — `impliedProbability`, `edge`, `isSignal`, `formatSignalMessage` not defined.

- [ ] **Step 3: Implement**

```js
// append to lib/signals.js
export function impliedProbability(decimalOdds) {
  return 1 / decimalOdds;
}

export function edge(estimatedProb, impliedProb) {
  return estimatedProb - impliedProb;
}

export function isSignal(estimatedProb, impliedProb, threshold = 0.05) {
  return edge(estimatedProb, impliedProb) >= threshold;
}

export function formatSignalMessage({ matchup, market, selection, price, impliedProb, estimatedProb, edgeValue, reasoning, emoji = '⚾' }) {
  return `${emoji} ${matchup} — ${market}: ${selection}\n` +
    `Cuota: ${price.toFixed(2)} (implícita ${(impliedProb * 100).toFixed(1)}%) | Estimada: ${(estimatedProb * 100).toFixed(1)}% | Edge: +${(edgeValue * 100).toFixed(1)}%\n` +
    `Motivo: ${reasoning}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/signals.test.js`
Expected: PASS, 24 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/signals.js lib/signals.test.js
git commit -m "feat: add edge calculation and signal message formatting"
```

---

### Task 7: MLB client — schedule fetch & parsing

**Files:**
- Create: `lib/mlb.js`
- Test: `lib/mlb.test.js`

- [ ] **Step 1: Write the failing tests (using an inline fixture)**

```js
// lib/mlb.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleGames, mapGameStatus } from './mlb.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/mlb.test.js`
Expected: FAIL — `lib/mlb.js` does not exist.

- [ ] **Step 3: Implement**

```js
// lib/mlb.js
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const GAME_STATUS_MAP = {
  'Scheduled': 'scheduled',
  'Pre-Game': 'scheduled',
  'Warmup': 'scheduled',
  'In Progress': 'live',
  'Final': 'final',
  'Game Over': 'final',
  'Postponed': 'postponed',
  'Cancelled': 'postponed',
  'Suspended': 'postponed',
};

export function mapGameStatus(detailedState) {
  return GAME_STATUS_MAP[detailedState] || 'scheduled';
}

export function parseScheduleGames(scheduleResponse) {
  const games = [];
  for (const d of scheduleResponse.dates || []) {
    for (const g of d.games || []) {
      games.push({
        gamePk: g.gamePk,
        status: mapGameStatus(g.status.detailedState),
        homeTeam: g.teams.home.team.name,
        awayTeam: g.teams.away.team.name,
        homeTeamId: g.teams.home.team.id,
        awayTeamId: g.teams.away.team.id,
      });
    }
  }
  return games;
}

export async function fetchSchedule(date) {
  const res = await fetch(`${MLB_API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher`);
  if (!res.ok) throw new Error(`MLB schedule fetch failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/mlb.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/mlb.js lib/mlb.test.js
git commit -m "feat: add MLB schedule fetch and parsing"
```

---

### Task 8: MLB client — last-10 record & recent pitcher ERA

**Files:**
- Modify: `lib/mlb.js`
- Modify: `lib/mlb.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// append to lib/mlb.test.js
import { parseLastTenRecord, computeRecentEra } from './mlb.js';

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
        { stat: { earnedRuns: 2, inningsPitched: '6.0' } },
        { stat: { earnedRuns: 3, inningsPitched: '5.1' } },
        { stat: { earnedRuns: 1, inningsPitched: '7.0' } },
      ],
    },
  ],
};

test('computeRecentEra: computes ERA from the last N starts', () => {
  const era = computeRecentEra(GAMELOG_FIXTURE, 3);
  // earned runs = 6, outs = 18+16+21 = 55 -> IP = 18.333
  assert.ok(Math.abs(era - (6 * 9) / (55 / 3)) < 0.01);
});

test('computeRecentEra: falls back to league average when no innings pitched', () => {
  const era = computeRecentEra({ stats: [{ splits: [] }] }, 5);
  assert.equal(era, 4.00);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/mlb.test.js`
Expected: FAIL — `parseLastTenRecord`, `computeRecentEra` not defined.

- [ ] **Step 3: Implement**

```js
// append to lib/mlb.js
const LEAGUE_AVG_ERA_FALLBACK = 4.00;

export function parseLastTenRecord(standingsResponse, teamId) {
  for (const record of standingsResponse.records || []) {
    for (const teamRecord of record.teamRecords || []) {
      if (teamRecord.team.id === teamId) {
        const lastTen = (teamRecord.records.splitRecords || []).find(r => r.type === 'lastTen');
        if (!lastTen) return 0.5;
        const total = lastTen.wins + lastTen.losses;
        return total === 0 ? 0.5 : lastTen.wins / total;
      }
    }
  }
  return 0.5;
}

export async function fetchStandings(season) {
  const res = await fetch(`${MLB_API}/standings?leagueId=103,104&season=${season}`);
  if (!res.ok) throw new Error(`MLB standings fetch failed: ${res.status}`);
  return res.json();
}

function inningsPitchedToOuts(ipString) {
  const [whole, partial = '0'] = String(ipString).split('.');
  return Number(whole) * 3 + Number(partial);
}

export function computeRecentEra(gameLogResponse, lastN = 5) {
  const splits = gameLogResponse.stats?.[0]?.splits || [];
  const recent = splits.slice(0, lastN);
  if (recent.length === 0) return LEAGUE_AVG_ERA_FALLBACK;
  const earnedRuns = recent.reduce((sum, s) => sum + Number(s.stat.earnedRuns || 0), 0);
  const outs = recent.reduce((sum, s) => sum + inningsPitchedToOuts(s.stat.inningsPitched || '0.0'), 0);
  const inningsPitched = outs / 3;
  if (inningsPitched === 0) return LEAGUE_AVG_ERA_FALLBACK;
  return (earnedRuns * 9) / inningsPitched;
}

export async function fetchPitcherGameLog(personId, season) {
  const res = await fetch(`${MLB_API}/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`);
  if (!res.ok) throw new Error(`MLB pitcher gamelog fetch failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/mlb.test.js`
Expected: PASS, 9 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/mlb.js lib/mlb.test.js
git commit -m "feat: add last-10 record and recent ERA computation"
```

---

### Task 9: MLB client — batter season stats & roster

**Files:**
- Modify: `lib/mlb.js`
- Modify: `lib/mlb.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// append to lib/mlb.test.js
import { extractBattingAvgAndPA, parseRoster } from './mlb.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/mlb.test.js`
Expected: FAIL — `extractBattingAvgAndPA`, `parseRoster` not defined.

- [ ] **Step 3: Implement**

```js
// append to lib/mlb.js
export function extractBattingAvgAndPA(batterStatsResponse) {
  const split = batterStatsResponse.stats?.[0]?.splits?.[0];
  if (!split) return { avg: 0.240, paPerGame: 4.3 };
  const stat = split.stat;
  const games = Number(stat.gamesPlayed || 1);
  const plateAppearances = Number(stat.plateAppearances || games * 4.3);
  return {
    avg: Number(stat.avg || 0.240),
    paPerGame: plateAppearances / games,
  };
}

export async function fetchBatterSeasonStats(personId, season) {
  const res = await fetch(`${MLB_API}/people/${personId}/stats?stats=season&group=hitting&season=${season}`);
  if (!res.ok) throw new Error(`MLB batter stats fetch failed: ${res.status}`);
  return res.json();
}

export function parseRoster(rosterResponse) {
  return (rosterResponse.roster || []).map(entry => ({
    personId: entry.person.id,
    fullName: entry.person.fullName,
  }));
}

export async function fetchTeamRoster(teamId) {
  const res = await fetch(`${MLB_API}/teams/${teamId}/roster`);
  if (!res.ok) throw new Error(`MLB roster fetch failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/mlb.test.js`
Expected: PASS, 12 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/mlb.js lib/mlb.test.js
git commit -m "feat: add batter season stats and roster parsing"
```

---

### Task 10: Odds client — moneyline & totals parsing

**Files:**
- Create: `lib/odds.js`
- Test: `lib/odds.test.js`

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/odds.test.js`
Expected: FAIL — `lib/odds.js` does not exist.

- [ ] **Step 3: Implement**

```js
// lib/odds.js
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

function extractMarket(event, marketKey) {
  for (const bookmaker of event.bookmakers || []) {
    const market = bookmaker.markets.find(m => m.key === marketKey);
    if (market) return { bookmaker: bookmaker.key, outcomes: market.outcomes };
  }
  return null;
}

export function parseOddsEvents(oddsResponse) {
  return oddsResponse.map(event => ({
    id: event.id,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    commenceTime: event.commence_time,
    h2h: extractMarket(event, 'h2h'),
    totals: extractMarket(event, 'totals'),
  }));
}

export function findTeamPrice(h2hMarket, teamName) {
  if (!h2hMarket) return null;
  const outcome = h2hMarket.outcomes.find(o => o.name === teamName);
  return outcome ? outcome.price : null;
}

export function findTotalsLine(totalsMarket, side) {
  if (!totalsMarket) return null;
  const outcome = totalsMarket.outcomes.find(o => o.name === side);
  return outcome ? { price: outcome.price, point: outcome.point } : null;
}

export async function fetchMlbOdds(apiKey) {
  const res = await fetch(`${ODDS_API_BASE}/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=h2h,totals&oddsFormat=decimal`);
  if (!res.ok) throw new Error(`Odds API fetch failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/odds.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/odds.js lib/odds.test.js
git commit -m "feat: add odds client with moneyline and totals parsing"
```

---

### Task 11: Odds client — player props parsing

**Files:**
- Modify: `lib/odds.js`
- Modify: `lib/odds.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// append to lib/odds.test.js
import { parsePlayerPropOutcomes } from './odds.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/odds.test.js`
Expected: FAIL — `parsePlayerPropOutcomes` not defined.

- [ ] **Step 3: Implement**

```js
// append to lib/odds.js
export function parsePlayerPropOutcomes(eventOddsResponse, marketKey, playerName) {
  for (const bookmaker of eventOddsResponse.bookmakers || []) {
    const market = bookmaker.markets.find(m => m.key === marketKey);
    if (!market) continue;
    const outcomes = market.outcomes.filter(o => o.description === playerName);
    if (outcomes.length) return outcomes;
  }
  return [];
}

export async function fetchEventPlayerProps(apiKey, eventId, marketsCsv) {
  const res = await fetch(`${ODDS_API_BASE}/sports/baseball_mlb/events/${eventId}/odds?apiKey=${apiKey}&regions=us&markets=${marketsCsv}&oddsFormat=decimal`);
  if (!res.ok) throw new Error(`Odds API player props fetch failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/odds.test.js`
Expected: PASS, 7 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/odds.js lib/odds.test.js
git commit -m "feat: add player prop parsing to odds client"
```

---

### Task 12: Telegram client

**Files:**
- Create: `lib/telegram.js`

- [ ] **Step 1: Implement (no unit test — thin network wrapper, verified manually in Task 18)**

```js
// lib/telegram.js
const TELEGRAM_API = 'https://api.telegram.org';

export async function sendTelegramMessage(botToken, chatId, text) {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`);
  return res.json();
}

export async function setTelegramWebhook(botToken, url) {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`Telegram setWebhook failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Manually verify against the real Telegram API**

Prerequisite: create a bot via [@BotFather](https://t.me/BotFather) (`/newbot`), copy the token into a local `.env`, and get your chat ID from [@userinfobot](https://t.me/userinfobot).

Run this one-off script and delete it after:
```bash
node -e "
import('./lib/telegram.js').then(({ sendTelegramMessage }) =>
  sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, 'Test message from setup')
    .then(r => console.log(JSON.stringify(r)))
);
"
```
Expected: a message "Test message from setup" arrives in your Telegram chat with the bot, and the script prints `"ok":true`.

- [ ] **Step 3: Commit**

```bash
git add lib/telegram.js
git commit -m "feat: add Telegram client"
```

---

### Task 13: Supabase client wrapper

**Files:**
- Create: `lib/db.js`

- [ ] **Step 1: Implement (no unit test — thin DB wrapper, verified manually)**

```js
// lib/db.js
import { createClient } from '@supabase/supabase-js';

export function createDbClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export async function upsertGame(db, game) {
  const { error } = await db.from('games').upsert({
    game_pk: game.gamePk,
    date: game.date,
    home_team: game.homeTeam,
    away_team: game.awayTeam,
    status: game.status,
  }, { onConflict: 'game_pk' });
  if (error) throw error;
}

export async function signalAlreadySentToday(db, gamePk, market, selection) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from('signals')
    .select('id')
    .eq('game_pk', gamePk)
    .eq('market', market)
    .eq('selection', selection)
    .gte('sent_at', `${today}T00:00:00Z`)
    .limit(1);
  if (error) throw error;
  return data.length > 0;
}

export async function insertSignal(db, signal) {
  const { error } = await db.from('signals').insert({
    game_pk: signal.gamePk,
    market: signal.market,
    selection: signal.selection,
    odds_price: signal.price,
    implied_prob: signal.impliedProb,
    estimated_prob: signal.estimatedProb,
    edge: signal.edge,
    reasoning: signal.reasoning,
  });
  if (error) throw error;
}

export async function getConfigValue(db, key, defaultValue) {
  const { data, error } = await db.from('config').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : defaultValue;
}

export async function setConfigValue(db, key, value) {
  const { error } = await db.from('config').upsert({ key, value: String(value) }, { onConflict: 'key' });
  if (error) throw error;
}
```

- [ ] **Step 2: Manually verify against the real Supabase project**

Prerequisite: Task 2's schema must already be applied, and `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` set in `.env` (Supabase dashboard → Project Settings → API).

Run:
```bash
node -e "
import('./lib/db.js').then(async ({ createDbClient, setConfigValue, getConfigValue }) => {
  const db = createDbClient();
  await setConfigValue(db, 'edge_threshold', '0.05');
  console.log(await getConfigValue(db, 'edge_threshold', 'MISSING'));
});
"
```
Expected: prints `0.05`, no thrown errors.

- [ ] **Step 3: Commit**

```bash
git add lib/db.js
git commit -m "feat: add Supabase client wrapper"
```

---

### Task 14: `api/scan.js` — cron orchestration (moneyline + totals)

**Files:**
- Create: `api/scan.js`

- [ ] **Step 1: Implement**

```js
// api/scan.js
import { createDbClient, upsertGame, signalAlreadySentToday, insertSignal, getConfigValue } from '../lib/db.js';
import { fetchSchedule, parseScheduleGames, fetchStandings, parseLastTenRecord, fetchPitcherGameLog, computeRecentEra } from '../lib/mlb.js';
import { fetchMlbOdds, parseOddsEvents, findTeamPrice, findTotalsLine } from '../lib/odds.js';
import { moneylineEstimate, projectedTotalRuns, overProbability, impliedProbability, edge, isSignal, formatSignalMessage } from '../lib/signals.js';
import { sendTelegramMessage } from '../lib/telegram.js';

const SEASON = new Date().getFullYear();

export default async function handler(req, res) {
  try {
    const db = createDbClient();
    const today = new Date().toISOString().slice(0, 10);
    const threshold = Number(await getConfigValue(db, 'edge_threshold', '0.05'));

    const [scheduleRaw, standingsRaw, oddsRaw] = await Promise.all([
      fetchSchedule(today),
      fetchStandings(SEASON),
      fetchMlbOdds(process.env.ODDS_API_KEY),
    ]);

    const games = parseScheduleGames(scheduleRaw);
    const oddsEvents = parseOddsEvents(oddsRaw);
    const sentMessages = [];

    for (const game of games) {
      if (game.status !== 'scheduled') continue;

      await upsertGame(db, { ...game, date: today });

      const oddsEvent = oddsEvents.find(
        e => e.homeTeam === game.homeTeam && e.awayTeam === game.awayTeam
      );
      if (!oddsEvent) continue;

      const homeLast10 = parseLastTenRecord(standingsRaw, game.homeTeamId);
      const awayLast10 = parseLastTenRecord(standingsRaw, game.awayTeamId);

      // Starting pitcher ERA is looked up from probable pitcher IDs on the schedule response.
      // If a probable pitcher isn't announced yet, fall back to league-average ERA (4.00).
      const homePitcherId = game.homeProbablePitcherId;
      const awayPitcherId = game.awayProbablePitcherId;
      const [homeEra, awayEra] = await Promise.all([
        homePitcherId ? computeRecentEra(await fetchPitcherGameLog(homePitcherId, SEASON)) : Promise.resolve(4.00),
        awayPitcherId ? computeRecentEra(await fetchPitcherGameLog(awayPitcherId, SEASON)) : Promise.resolve(4.00),
      ]);

      // Moneyline
      const homeWinProb = moneylineEstimate({
        home: { last10WinPct: homeLast10, startingPitcherEra: homeEra },
        away: { last10WinPct: awayLast10, startingPitcherEra: awayEra },
      });
      const awayWinProb = 1 - homeWinProb;

      for (const [team, prob] of [[game.homeTeam, homeWinProb], [game.awayTeam, awayWinProb]]) {
        const price = findTeamPrice(oddsEvent.h2h, team);
        if (!price) continue;
        const implied = impliedProbability(price);
        const edgeValue = edge(prob, implied);
        if (!isSignal(prob, implied, threshold)) continue;
        if (await signalAlreadySentToday(db, game.gamePk, 'moneyline', team)) continue;

        const reasoning = `ERA reciente: ${game.homeTeam} ${homeEra.toFixed(2)} / ${game.awayTeam} ${awayEra.toFixed(2)}. Últimos 10: ${game.homeTeam} ${(homeLast10 * 10).toFixed(0)}-${(10 - homeLast10 * 10).toFixed(0)}, ${game.awayTeam} ${(awayLast10 * 10).toFixed(0)}-${(10 - awayLast10 * 10).toFixed(0)}.`;
        const message = formatSignalMessage({
          matchup: `${game.awayTeam} @ ${game.homeTeam}`,
          market: 'Moneyline',
          selection: `${team} gana`,
          price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
        });

        await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, message);
        await insertSignal(db, { gamePk: game.gamePk, market: 'moneyline', selection: team, price, impliedProb: implied, estimatedProb: prob, edge: edgeValue, reasoning });
        sentMessages.push(message);
      }

      // Totals — runsPerGame proxied from last-10 win pct is not accurate enough on its own,
      // so this uses a flat league-average runsPerGame per team as the v1 baseline.
      const projectedTotal = projectedTotalRuns({
        home: { runsPerGame: 4.5, startingPitcherEra: homeEra },
        away: { runsPerGame: 4.5, startingPitcherEra: awayEra },
      });
      for (const side of ['Over', 'Under']) {
        const line = findTotalsLine(oddsEvent.totals, side);
        if (!line) continue;
        const prob = side === 'Over' ? overProbability(line.point, projectedTotal) : 1 - overProbability(line.point, projectedTotal);
        const implied = impliedProbability(line.price);
        const edgeValue = edge(prob, implied);
        if (!isSignal(prob, implied, threshold)) continue;
        if (await signalAlreadySentToday(db, game.gamePk, 'totals', side)) continue;

        const reasoning = `Proyección de carreras: ${projectedTotal.toFixed(1)} vs línea ${line.point}. ERA recientes: ${homeEra.toFixed(2)} / ${awayEra.toFixed(2)}.`;
        const message = formatSignalMessage({
          matchup: `${game.awayTeam} @ ${game.homeTeam}`,
          market: 'Totals',
          selection: `${side} ${line.point}`,
          price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
        });

        await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, message);
        await insertSignal(db, { gamePk: game.gamePk, market: 'totals', selection: `${side} ${line.point}`, price: line.price, impliedProb: implied, estimatedProb: prob, edge: edgeValue, reasoning });
        sentMessages.push(message);
      }
    }

    res.status(200).json({ scanned: games.length, signalsSent: sentMessages.length });
  } catch (err) {
    console.error('scan.js error:', err);
    res.status(500).json({ error: err.message });
  }
}
```

Note: `game.homeProbablePitcherId` / `game.awayProbablePitcherId` are added to `parseScheduleGames` in Task 7's fixture shape via the `hydrate=probablePitcher` param — extend `parseScheduleGames` in `lib/mlb.js` to also read `g.teams.home.probablePitcher?.id` and `g.teams.away.probablePitcher?.id` into those two fields before running this task (add this as a one-line addition to the object literal in `parseScheduleGames`, and add one fixture-based test case with a `probablePitcher` field present and one without, following the same pattern as the existing tests in `lib/mlb.test.js`).

- [ ] **Step 2: Manually verify with a real API call**

Run: `node -e "import('./api/scan.js').then(m => m.default({}, { status: c => ({ json: d => console.log(c, JSON.stringify(d)) }) }))"`
Expected: prints `200 {"scanned":N,"signalsSent":M}` with no thrown errors (M may be 0 if no games clear the edge threshold that day — that's expected, not a failure).

- [ ] **Step 3: Commit**

```bash
git add api/scan.js lib/mlb.js lib/mlb.test.js
git commit -m "feat: add cron scan orchestration for moneyline and totals"
```

---

### Task 15: `api/scan.js` — extend with player prop signals

**Files:**
- Modify: `api/scan.js`

- [ ] **Step 1: Implement**

```js
// add to api/scan.js, inside the `for (const game of games)` loop, after the totals block
import { fetchTeamRoster, parseRoster, fetchBatterSeasonStats, extractBattingAvgAndPA } from '../lib/mlb.js';
import { fetchEventPlayerProps, parsePlayerPropOutcomes } from '../lib/odds.js';
import { overProbabilityProp } from '../lib/signals.js';

// Player props (batter hits) — v1 uses season-to-date batting average as the expected
// hit rate proxy. It does not yet split by opposing pitcher's throwing hand; that refinement
// is a documented fast-follow once the heuristic is validated via backtesting.
const rosterRaw = await fetchTeamRoster(game.homeTeamId);
const roster = parseRoster(rosterRaw);
const propEventOdds = await fetchEventPlayerProps(process.env.ODDS_API_KEY, oddsEvent.id, 'batter_hits');

for (const player of roster.slice(0, 5)) {
  const outcomes = parsePlayerPropOutcomes(propEventOdds, 'batter_hits', player.fullName);
  if (outcomes.length === 0) continue;

  const battingStats = await fetchBatterSeasonStats(player.personId, SEASON);
  const { avg, paPerGame } = extractBattingAvgAndPA(battingStats);
  const expectedRate = avg * paPerGame;

  const overOutcome = outcomes.find(o => o.name === 'Over');
  if (!overOutcome) continue;

  const prob = overProbabilityProp(overOutcome.point, expectedRate);
  const implied = impliedProbability(overOutcome.price);
  const edgeValue = edge(prob, implied);
  if (!isSignal(prob, implied, threshold)) continue;
  if (await signalAlreadySentToday(db, game.gamePk, 'player_prop', `${player.fullName} hits`)) continue;

  const reasoning = `AVG temporada ${avg.toFixed(3)} en ${paPerGame.toFixed(1)} PA/juego -> tasa esperada ${expectedRate.toFixed(2)} hits/juego vs línea ${overOutcome.point}.`;
  const message = formatSignalMessage({
    matchup: `${game.awayTeam} @ ${game.homeTeam}`,
    market: 'Player Prop',
    selection: `${player.fullName} Over ${overOutcome.point} hits`,
    price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
  });

  await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, message);
  await insertSignal(db, { gamePk: game.gamePk, market: 'player_prop', selection: `${player.fullName} hits`, price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edge: edgeValue, reasoning });
  sentMessages.push(message);
}
```

Place this block right after the totals `for` loop and before the closing brace of the `for (const game of games)` loop. Add the three new imports to the top of `api/scan.js` alongside the existing ones.

- [ ] **Step 2: Manually verify**

Run the same command as Task 14 Step 2.
Expected: prints `200 {...}` with no thrown errors; if props are found and clear the edge threshold, `signalsSent` reflects them and the corresponding Telegram messages arrive.

- [ ] **Step 3: Commit**

```bash
git add api/scan.js
git commit -m "feat: add player prop signals to scan orchestration"
```

---

### Task 16: `api/telegram-webhook.js` — `/hoy` and `/senales` commands

**Files:**
- Create: `api/telegram-webhook.js`

- [ ] **Step 1: Implement**

```js
// api/telegram-webhook.js
import { createDbClient } from '../lib/db.js';
import { fetchSchedule, parseScheduleGames } from '../lib/mlb.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { runScan } from './scan.js';

const STATUS_LABEL = { scheduled: 'Programado', live: 'En vivo', final: 'Terminado', postponed: 'Pospuesto' };

export default async function handler(req, res) {
  const update = req.body;
  const text = update?.message?.text?.trim() || '';
  const chatId = update?.message?.chat?.id;
  if (!chatId || String(chatId) !== process.env.TELEGRAM_CHAT_ID) {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    if (text === '/hoy') {
      const today = new Date().toISOString().slice(0, 10);
      const games = parseScheduleGames(await fetchSchedule(today));
      const lines = games.map(g => `${g.awayTeam} @ ${g.homeTeam} — ${STATUS_LABEL[g.status]}`);
      const reply = lines.length ? lines.join('\n') : 'No hay juegos de MLB hoy.';
      await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, reply);
    } else if (text === '/senales') {
      const result = await runScan();
      await sendTelegramMessage(
        process.env.TELEGRAM_BOT_TOKEN,
        chatId,
        result.signalsSent > 0 ? `Se enviaron ${result.signalsSent} señales nuevas.` : 'No se encontraron señales con edge suficiente ahora mismo.'
      );
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('telegram-webhook.js error:', err);
    res.status(200).json({ ok: true }); // always 200 to Telegram, log the error server-side
  }
}
```

- [ ] **Step 2: Refactor `api/scan.js` to export a reusable `runScan` function**

In `api/scan.js`, rename the body of the current `handler` function's try block into a standalone exported function, and have `handler` call it:

```js
// in api/scan.js, replace the default export with:
export async function runScan() {
  const db = createDbClient();
  // ... (all the existing logic from the try block, ending with:)
  return { scanned: games.length, signalsSent: sentMessages.length };
}

export default async function handler(req, res) {
  try {
    const result = await runScan();
    res.status(200).json(result);
  } catch (err) {
    console.error('scan.js error:', err);
    res.status(500).json({ error: err.message });
  }
}
```

- [ ] **Step 3: Manually verify**

Run: `node --test lib/*.test.js` (confirm the refactor didn't break existing unit tests — none of them touch `api/scan.js`, so this is a sanity check that nothing else broke).
Expected: PASS, same test count as after Task 15.

Full end-to-end webhook verification (with a real Telegram chat) happens in Task 18 after the webhook URL is deployed and registered.

- [ ] **Step 4: Commit**

```bash
git add api/telegram-webhook.js api/scan.js
git commit -m "feat: add /hoy and /senales Telegram commands"
```

---

### Task 17: `api/telegram-webhook.js` — `/partido` and `/config edge` commands

**Files:**
- Modify: `api/telegram-webhook.js`

- [ ] **Step 1: Implement**

```js
// add to api/telegram-webhook.js, inside the try block, as additional else-if branches
} else if (text.startsWith('/partido ')) {
  const query = text.slice('/partido '.length).trim().toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const games = parseScheduleGames(await fetchSchedule(today));
  const match = games.find(g => g.homeTeam.toLowerCase().includes(query) || g.awayTeam.toLowerCase().includes(query));
  if (!match) {
    await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, `No encontré un juego de hoy para "${query}".`);
  } else {
    await sendTelegramMessage(
      process.env.TELEGRAM_BOT_TOKEN,
      chatId,
      `${match.awayTeam} @ ${match.homeTeam} — ${STATUS_LABEL[match.status]}. Usa /senales para ver el análisis completo del día (incluye este juego si tiene edge suficiente).`
    );
  }
} else if (text.startsWith('/config edge ')) {
  const value = Number(text.slice('/config edge '.length).trim());
  if (Number.isNaN(value) || value <= 0 || value >= 1) {
    await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, 'Uso: /config edge 0.05 (un número entre 0 y 1, ej. 0.05 = 5%).');
  } else {
    const db = createDbClient();
    await setConfigValue(db, 'edge_threshold', String(value));
    await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, `Umbral de edge actualizado a ${(value * 100).toFixed(1)}%.`);
  }
}
```

Add `setConfigValue` to the existing `import { createDbClient } from '../lib/db.js';` line at the top of the file (`import { createDbClient, setConfigValue } from '../lib/db.js';`).

Note: `/partido` gives a lightweight status check rather than running the full per-game heuristic standalone — running the complete signal calculation for a single team requires the same odds/stats fetches as the full scan, so this command intentionally points the user to `/senales` for the full breakdown. This keeps the command simple and avoids duplicating the entire orchestration logic from `runScan()`.

- [ ] **Step 2: Manually verify**

Run: `node --test lib/*.test.js`
Expected: PASS, same test count as Task 16 (no lib changes in this task).

- [ ] **Step 3: Commit**

```bash
git add api/telegram-webhook.js
git commit -m "feat: add /partido and /config edge Telegram commands"
```

---

### Task 18: Deploy to Vercel and wire up Telegram + Cron

**Files:** none (infrastructure/config steps)

- [ ] **Step 1: Push the repo to GitHub**

Since Vercel deploys from a git remote, create a GitHub repo and push:
```bash
gh repo create mlb-telegram-signals --private --source=. --remote=origin
git push -u origin main
```

- [ ] **Step 2: Import the project into Vercel**

In the Vercel dashboard, import the new GitHub repo. When prompted for environment variables, set: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ODDS_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (same values as your local `.env`). Deploy.

Expected: deployment succeeds, you get a URL like `https://mlb-telegram-signals.vercel.app`.

- [ ] **Step 3: Register the Telegram webhook**

Run locally (one-off, do not commit a script with the token inline):
```bash
node -e "
import('./lib/telegram.js').then(({ setTelegramWebhook }) =>
  setTelegramWebhook(process.env.TELEGRAM_BOT_TOKEN, 'https://mlb-telegram-signals.vercel.app/api/telegram-webhook')
    .then(r => console.log(JSON.stringify(r)))
);
"
```
Expected: prints `{"ok":true,"result":true,...}`.

- [ ] **Step 4: Verify commands end-to-end**

In Telegram, message your bot `/hoy`. Expected: a reply listing today's MLB games within a few seconds.
Then message `/senales`. Expected: a reply confirming how many signals were sent (0 or more), and if any, corresponding signal messages arrive as separate messages.

- [ ] **Step 5: Verify the cron fires**

In the Vercel dashboard, go to the project's Cron Jobs tab and trigger `/api/scan` manually ("Run now" if available), or wait for the next scheduled run.
Expected: the Vercel function logs show `{"scanned":N,"signalsSent":M}` with no errors, matching Task 14/15's manual test.

- [ ] **Step 6: Commit any config drift**

If any code changes were needed to fix deployment issues, commit them:
```bash
git add -A
git commit -m "fix: deployment adjustments"
```
(Skip this step if no code changes were needed.)

---

### Task 19: Directional backtesting script

**Files:**
- Create: `scripts/backtest.js`

- [ ] **Step 1: Implement**

```js
// scripts/backtest.js
// Usage: node scripts/backtest.js 2026-06-01 2026-06-30
// Reconstructs what the moneyline heuristic would have picked for each completed game
// in the date range, using standings/ERA data as they existed then, and compares
// against the actual final score. Prints direction accuracy — no ROI (no historical odds available).
import { fetchSchedule, parseScheduleGames, fetchStandings, parseLastTenRecord, fetchPitcherGameLog, computeRecentEra } from '../lib/mlb.js';
import { moneylineEstimate } from '../lib/signals.js';

const [, , startDate, endDate] = process.argv;
if (!startDate || !endDate) {
  console.error('Usage: node scripts/backtest.js <start-date YYYY-MM-DD> <end-date YYYY-MM-DD>');
  process.exit(1);
}

function dateRange(start, end) {
  const dates = [];
  let current = new Date(start);
  const last = new Date(end);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function fetchFinalScore(gamePk) {
  const res = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/linescore`);
  if (!res.ok) return null;
  const data = await res.json();
  return { home: data.teams?.home?.runs, away: data.teams?.away?.runs };
}

async function main() {
  const season = new Date(startDate).getFullYear();
  let correct = 0;
  let total = 0;

  for (const date of dateRange(startDate, endDate)) {
    const games = parseScheduleGames(await fetchSchedule(date));
    const standingsRaw = await fetchStandings(season);

    for (const game of games) {
      if (game.status !== 'final') continue;
      const score = await fetchFinalScore(game.gamePk);
      if (!score || score.home == null || score.away == null) continue;

      const homeLast10 = parseLastTenRecord(standingsRaw, game.homeTeamId);
      const awayLast10 = parseLastTenRecord(standingsRaw, game.awayTeamId);
      const homeEra = game.homeProbablePitcherId
        ? computeRecentEra(await fetchPitcherGameLog(game.homeProbablePitcherId, season))
        : 4.00;
      const awayEra = game.awayProbablePitcherId
        ? computeRecentEra(await fetchPitcherGameLog(game.awayProbablePitcherId, season))
        : 4.00;

      const homeWinProb = moneylineEstimate({
        home: { last10WinPct: homeLast10, startingPitcherEra: homeEra },
        away: { last10WinPct: awayLast10, startingPitcherEra: awayEra },
      });

      const predictedHomeWin = homeWinProb > 0.5;
      const actualHomeWin = score.home > score.away;
      total += 1;
      if (predictedHomeWin === actualHomeWin) correct += 1;
    }
  }

  const accuracy = total === 0 ? 0 : (correct / total) * 100;
  console.log(`Backtest ${startDate} to ${endDate}: ${correct}/${total} correct (${accuracy.toFixed(1)}%)`);
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it against a past date range**

Run: `node scripts/backtest.js 2026-06-01 2026-06-07`
Expected: prints `Backtest 2026-06-01 to 2026-06-07: X/Y correct (Z%)` with no thrown errors. This is a real, slow network-bound run (many sequential MLB API calls) — expect it to take a few minutes for a week of games.

- [ ] **Step 3: Commit**

```bash
git add scripts/backtest.js
git commit -m "feat: add directional backtesting script"
```

---

### Task 20: Final end-to-end verification checklist

**Files:** none

- [ ] **Step 1: Run the full unit test suite**

Run: `npm test`
Expected: all tests pass (signals.js + mlb.js + odds.js suites).

- [ ] **Step 2: Confirm live signal delivery**

Wait for a day with real MLB games, and confirm at least one cron-triggered scan (Task 18 Step 5) or `/senales` command run produces either a real signal message or a "no signals" confirmation — not an error.

- [ ] **Step 3: Confirm Supabase history is populated**

In the Supabase Table Editor, check the `games` and `signals` tables have rows after a live scan.
Expected: `games` has today's games, and if any signals were sent, `signals` has matching rows with `reasoning` text populated.

- [ ] **Step 4: Run a backtest sanity check**

Run: `node scripts/backtest.js` over a full past week and read the printed accuracy.
Expected: a number between 0–100%; if it's dramatically below 50%, that's a signal (no pun intended) the heuristic needs revisiting before trusting it live — note this for a future iteration rather than blocking this plan's completion.

---

## Self-Review Notes

- **Spec coverage:** moneyline/totals/props (Tasks 3–6, 14–15), reasoning shown per message (Task 6/14/15), Supabase history + dedupe (Tasks 2, 13), backtesting direction-only (Task 19, matches the agreed limitation of no historical odds), Telegram commands `/hoy` `/senales` `/partido` `/config edge` (Tasks 16–17), Vercel + Cron deployment (Task 18), error handling for postponed games (Task 14 `if (game.status !== 'scheduled') continue`), rate-limit/mismatch omission is implicit in the `if (!oddsEvent) continue` / `if (!price) continue` guards throughout Task 14/15.
- **Known simplification carried into the plan:** player props use season batting average rather than the vs-pitcher-hand splits described narratively in the original design conversation — this was called out explicitly in Task 15 as a v1 simplification consistent with the "empezar simple" decision, not a placeholder.
- **Type consistency check:** `signal` objects passed to `insertSignal` consistently use `gamePk`, `market`, `selection`, `price`, `impliedProb`, `estimatedProb`, `edge`, `reasoning` across Tasks 13, 14, 15. `formatSignalMessage` consistently receives `matchup`, `market`, `selection`, `price`, `impliedProb`, `estimatedProb`, `edgeValue`, `reasoning` across Tasks 6, 14, 15.
