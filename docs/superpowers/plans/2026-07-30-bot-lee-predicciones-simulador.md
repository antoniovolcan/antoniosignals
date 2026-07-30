# Bot lee predicciones del simulador (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before sending a moneyline signal, look up whether a separate MLB Monte Carlo simulator (a different local project, not part of this repo) has a prediction for the same game in Supabase, and if so, append a one-line note to the Telegram message saying whether it agrees or disagrees — purely informational, no change to `edge_threshold` or signal-sending logic.

**Architecture:** A new read-only `getSimPrediction` function in `lib/db.js` queries the `sim_predictions` table (written by the other project) and never throws — a missing row or a failed query both resolve to `null`, so this feature can never make the bot depend on the simulator having run. A new pure function `formatSimComparisonNote` in `lib/signals.js` turns a fetched row plus "which team the bot favors" into the note text. `api/scan.js` wires both together inside the existing moneyline loop.

**Tech Stack:** Node.js (ESM), `@supabase/supabase-js` (already a dependency), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-07-30-simulador-segunda-opinion-bot-design.md` in the other project (`C:\Users\anton\OneDrive\Escritorio\ui-ux-pro-max-skill-main`) — read it there for the full cross-project design and the `sim_predictions` table schema.

---

## Task 1: Add `getSimPrediction` to `lib/db.js`

**Files:**
- Modify: `lib/db.js`

No test for this task — this repo's convention (see the rest of `lib/db.js`) is that thin Supabase query wrappers aren't unit-tested individually; they're exercised through manual/integration verification (Task 3). `formatSimComparisonNote` (Task 2) is where the actual logic lives and gets unit tests.

- [ ] **Step 1: Add the function**

Add this to `lib/db.js` (e.g. near `getGameInfo`, since it's a similarly-shaped read-only lookup):

```javascript
// Looks up the other MLB-simulator project's nightly moneyline prediction for
// this exact game, if it uploaded one. Deliberately never throws -- a missing
// row (simulator didn't run that night, doesn't have this game, or the table
// doesn't exist yet) and a failed query both resolve to null, so this feature
// can never make the bot depend on the simulator having run.
export async function getSimPrediction(db, date, homeTeam, awayTeam) {
  try {
    const { data, error } = await db
      .from('sim_predictions')
      .select('home_team, away_team, home_win_pct, away_win_pct')
      .eq('date', date)
      .eq('home_team', homeTeam)
      .eq('away_team', awayTeam)
      .maybeSingle();
    if (error || !data) return null;
    return {
      homeTeam: data.home_team,
      awayTeam: data.away_team,
      homeWinPct: data.home_win_pct,
      awayWinPct: data.away_win_pct,
    };
  } catch (err) {
    console.error(`Failed to fetch sim prediction for ${awayTeam} @ ${homeTeam}:`, err);
    return null;
  }
}
```

- [ ] **Step 2: Verify nothing else broke**

Run: `npm test`
Expected: PASS — 219 tests (unchanged; this task adds no tests of its own, see rationale above)

- [ ] **Step 3: Commit**

```bash
git add lib/db.js
git commit -m "feat: add getSimPrediction to read the other project's nightly moneyline prediction"
```

---

## Task 2: Add `formatSimComparisonNote` to `lib/signals.js`

**Files:**
- Modify: `lib/signals.js`
- Modify: `lib/signals.test.js`

This is a pure function — no network, no Supabase types — so it's fully unit-testable, matching the rest of `lib/signals.js`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/signals.test.js` (add `formatSimComparisonNote` to the existing `import { ..., formatSignalMessage } from './signals.js';` line, or add a new import line — either is fine, follow whichever the file already does for functions added late, e.g. `import { formatCareerEraNote, formatCareerEraPairNote } from './signals.js';` is its own line):

```javascript
import { formatSimComparisonNote } from './signals.js';

test('formatSimComparisonNote: returns empty string when there is no prediction', () => {
  assert.equal(formatSimComparisonNote(null, 'New York Yankees'), '');
});

test('formatSimComparisonNote: agrees with the bot\'s favored team', () => {
  const simPrediction = {
    homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox',
    homeWinPct: 0.62, awayWinPct: 0.38,
  };
  const note = formatSimComparisonNote(simPrediction, 'New York Yankees');
  assert.ok(note.includes('coincide'));
  assert.ok(note.includes('New York Yankees'));
  assert.ok(note.includes('62'));
});

test('formatSimComparisonNote: disagrees with the bot\'s favored team', () => {
  const simPrediction = {
    homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox',
    homeWinPct: 0.38, awayWinPct: 0.62,
  };
  const note = formatSimComparisonNote(simPrediction, 'New York Yankees');
  assert.ok(note.includes('difiere'));
  assert.ok(note.includes('Boston Red Sox'));
});

test('formatSimComparisonNote: home team favored on an exact 50/50 split', () => {
  const simPrediction = {
    homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox',
    homeWinPct: 0.5, awayWinPct: 0.5,
  };
  const note = formatSimComparisonNote(simPrediction, 'New York Yankees');
  assert.ok(note.includes('coincide'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `formatSimComparisonNote is not a function` (or import error), the 4 new tests fail

- [ ] **Step 3: Implement `formatSimComparisonNote`**

Add to `lib/signals.js` (e.g. right after `formatSignalMessage`, since it's another message-formatting helper):

```javascript
// Compares the other MLB-simulator project's moneyline prediction (a Monte
// Carlo simulation) against which team THIS bot's own formula-based model
// favored, and returns a short note to append to the Telegram message. Purely
// informational -- never changes edge_threshold or whether a signal is sent.
// On an exact 50/50 split the simulator's own tie-break (home team) is used,
// matching the convention already documented in the simulator's own
// comparison module.
export function formatSimComparisonNote(simPrediction, botFavoredTeam) {
  if (!simPrediction) return '';

  const simFavoredTeam = simPrediction.homeWinPct >= simPrediction.awayWinPct
    ? simPrediction.homeTeam
    : simPrediction.awayTeam;

  if (simFavoredTeam === botFavoredTeam) {
    const pct = Math.max(simPrediction.homeWinPct, simPrediction.awayWinPct);
    return ` Simulador coincide: ${simFavoredTeam} (${(pct * 100).toFixed(0)}%).`;
  }
  return ` Simulador difiere: predice ${simFavoredTeam}.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 223 tests (219 previous + 4 new)

- [ ] **Step 5: Commit**

```bash
git add lib/signals.js lib/signals.test.js
git commit -m "feat: add formatSimComparisonNote to compare sim prediction vs bot's own model"
```

---

## Task 3: Wire it into `api/scan.js`

**Files:**
- Modify: `api/scan.js`

No new tests — `scan.js` has no existing test file (it's all integration logic, verified manually per this repo's established convention, same as the rest of the file). Verified with the manual smoke test in Step on this task.

- [ ] **Step 1: Update the imports**

In `api/scan.js`, change this line:

```javascript
import { createDbClient, upsertGame, getTodaysSignalId, insertSignal, updateSignal, getConfigValue, gameAlreadyScannedToday, markGameScanned } from '../lib/db.js';
```

to:

```javascript
import { createDbClient, upsertGame, getTodaysSignalId, insertSignal, updateSignal, getConfigValue, gameAlreadyScannedToday, markGameScanned, getSimPrediction } from '../lib/db.js';
```

And change this line:

```javascript
import {
  moneylineEstimate, projectedTotalRuns, projectedFirstFiveInningsRuns, overProbability, overProbabilityProp,
  impliedProbability, edge, isSignal, isConfidentEnough, formatSignalMessage,
  expectedPitcherStrikeouts, blendEraEstimates, computeOffensiveFactor, computeLineupOps, LEAGUE_AVG_TOP_WEIGHTED_OPS,
  computeAveragePowerContactFactor, adjustedInningsForEarlyHookRisk, computeWeatherFactorForStrikeouts,
  CAREER_ERA_WEIGHT, CAREER_K9_WEIGHT, formatCareerEraNote, formatCareerEraPairNote,
  TEAM_RECORD_RECENT_WEIGHT,
} from '../lib/signals.js';
```

to:

```javascript
import {
  moneylineEstimate, projectedTotalRuns, projectedFirstFiveInningsRuns, overProbability, overProbabilityProp,
  impliedProbability, edge, isSignal, isConfidentEnough, formatSignalMessage,
  expectedPitcherStrikeouts, blendEraEstimates, computeOffensiveFactor, computeLineupOps, LEAGUE_AVG_TOP_WEIGHTED_OPS,
  computeAveragePowerContactFactor, adjustedInningsForEarlyHookRisk, computeWeatherFactorForStrikeouts,
  CAREER_ERA_WEIGHT, CAREER_K9_WEIGHT, formatCareerEraNote, formatCareerEraPairNote,
  TEAM_RECORD_RECENT_WEIGHT, formatSimComparisonNote,
} from '../lib/signals.js';
```

- [ ] **Step 2: Fetch the sim prediction once per game**

Locate this line (right before the moneyline `for` loop):

```javascript
      for (const [team, prob] of [[game.homeTeam, homeWinProb], [game.awayTeam, awayWinProb]]) {
```

Add this line immediately before it:

```javascript
      const simPrediction = await getSimPrediction(db, today, game.homeTeam, game.awayTeam);

      for (const [team, prob] of [[game.homeTeam, homeWinProb], [game.awayTeam, awayWinProb]]) {
```

- [ ] **Step 3: Append the note to the moneyline reasoning**

Locate the moneyline `reasoning` assignment (inside that same loop):

```javascript
        const reasoning = `El modelo compara el pitcheo (ERA de temporada + últimos 5 arranques + carrera), el récord de cada equipo (últimos 15 partidos y temporada completa), y qué tan bien está bateando cada lineup titular contra la mano del pitcher rival. Abridor de ${game.homeTeam}: ${homePitcherName}, ERA de temporada ${homeSeasonEra.toFixed(2)}${formatCareerEraNote(homeCareerEra)} y reciente ${homeEra.toFixed(2)}. Abridor de ${game.awayTeam}: ${awayPitcherName}, ERA de temporada ${awaySeasonEra.toFixed(2)}${formatCareerEraNote(awayCareerEra)} y reciente ${awayEra.toFixed(2)}. Récord: ${game.homeTeam} tiene ${(homeRecord.seasonWinPct * 100).toFixed(1)}% de victorias en la temporada (${(homeRecord.recentWinPct * 100).toFixed(1)}% en sus últimos 15), ${game.awayTeam} ${(awayRecord.seasonWinPct * 100).toFixed(1)}% en la temporada (${(awayRecord.recentWinPct * 100).toFixed(1)}% en sus últimos 15). El lineup titular de ${game.homeTeam} batea para ${homeLineupOps.toFixed(3)} de OPS contra pitchers de esa mano, el de ${game.awayTeam} para ${awayLineupOps.toFixed(3)}. Con todo esto, el modelo calcula que ${team} tiene más probabilidad de ganar de la que refleja la cuota de la casa.`;
```

Change the end of that template literal from:

```
`;
```

to append `formatSimComparisonNote(simPrediction, team)`:

```javascript
        const reasoning = `El modelo compara el pitcheo (ERA de temporada + últimos 5 arranques + carrera), el récord de cada equipo (últimos 15 partidos y temporada completa), y qué tan bien está bateando cada lineup titular contra la mano del pitcher rival. Abridor de ${game.homeTeam}: ${homePitcherName}, ERA de temporada ${homeSeasonEra.toFixed(2)}${formatCareerEraNote(homeCareerEra)} y reciente ${homeEra.toFixed(2)}. Abridor de ${game.awayTeam}: ${awayPitcherName}, ERA de temporada ${awaySeasonEra.toFixed(2)}${formatCareerEraNote(awayCareerEra)} y reciente ${awayEra.toFixed(2)}. Récord: ${game.homeTeam} tiene ${(homeRecord.seasonWinPct * 100).toFixed(1)}% de victorias en la temporada (${(homeRecord.recentWinPct * 100).toFixed(1)}% en sus últimos 15), ${game.awayTeam} ${(awayRecord.seasonWinPct * 100).toFixed(1)}% en la temporada (${(awayRecord.recentWinPct * 100).toFixed(1)}% en sus últimos 15). El lineup titular de ${game.homeTeam} batea para ${homeLineupOps.toFixed(3)} de OPS contra pitchers de esa mano, el de ${game.awayTeam} para ${awayLineupOps.toFixed(3)}. Con todo esto, el modelo calcula que ${team} tiene más probabilidad de ganar de la que refleja la cuota de la casa.${formatSimComparisonNote(simPrediction, team)}`;
```

(Only the moneyline `reasoning` gets this — totals, F5 totals, and pitcher strikeouts are untouched, since the simulator only predicts moneyline, per the spec.)

- [ ] **Step 4: Verify nothing broke**

Run: `npm test`
Expected: PASS — 223 tests (unchanged from Task 2, this task adds no new unit tests)

- [ ] **Step 5: Commit**

```bash
git add api/scan.js
git commit -m "feat: show sim prediction agreement/disagreement in moneyline signals"
```

---

## Task 4: Migration file + manual verification

**Files:**
- Create: `supabase/migrations/004_add_sim_predictions.sql`

No subagent dispatch for this task — running a migration against the user's real Supabase database and confirming a real deploy needs to happen with the user directly.

- [ ] **Step 1: Create the migration file (documentation of the schema, matches existing convention — not auto-applied)**

Create `supabase/migrations/004_add_sim_predictions.sql`:

```sql
create table sim_predictions (
  id bigint generated always as identity primary key,
  date date not null,
  home_team text not null,
  away_team text not null,
  home_pitcher text,
  away_pitcher text,
  home_win_pct numeric not null,
  away_win_pct numeric not null,
  sims integer not null,
  created_at timestamptz not null default now(),
  unique (date, home_team, away_team)
);
```

Commit this file even though the SQL itself is run by hand in the Supabase SQL Editor (same as migrations 001-003):

```bash
git add supabase/migrations/004_add_sim_predictions.sql
git commit -m "docs: add sim_predictions migration (run manually in Supabase SQL Editor)"
```

- [ ] **Step 2: Confirm the table exists in Supabase**

This depends on Plan A (the other project) having already run its own Task 3, which asks the user to run this same SQL. If it hasn't been run yet, ask the user to run it now via the Supabase SQL Editor before continuing.

- [ ] **Step 3: Deploy and verify with real data**

Follow this repo's standing rule (see `context.md`): `git push` (if a remote is configured), then `vercel --prod --yes`, then verify. After the other project's nightly `run_slate_diario.py` has uploaded at least one night's predictions to `sim_predictions`, trigger a scan (`/senales` in Telegram, or hit `/api/scan?secret=<CRON_SECRET>` directly) for a day where both a sim prediction and a moneyline signal exist, and confirm the Telegram message includes the new "Simulador coincide/difiere" line.

---

## Self-Review Notes

- **Spec coverage:** `getSimPrediction` (never throws, missing-row and failed-query both → `null`) — Task 1. `formatSimComparisonNote` (agree/disagree wording, 50/50 tie-break matching the simulator's own documented convention) — Task 2. Wiring into `scan.js`'s moneyline block only, no change to `edge_threshold`/signal-sending — Task 3. Migration SQL matching the schema in the cross-project spec exactly, run manually — Task 4.
- **Type consistency:** `getSimPrediction(db, date, homeTeam, awayTeam)` (Task 1) returns `{homeTeam, awayTeam, homeWinPct, awayWinPct}` or `null` — exactly the shape `formatSimComparisonNote(simPrediction, botFavoredTeam)` (Task 2) expects as its first argument. `scan.js` (Task 3) calls both with matching argument order/shape.
- **No placeholders:** every step has literal, complete code.
