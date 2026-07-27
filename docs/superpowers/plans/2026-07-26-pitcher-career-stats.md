# Pitcher Career Stats (ERA/K9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add each starting pitcher's career ERA and career K/9 (all regular seasons strictly before the current one) as a low-weight third input blended on top of the existing recent+season ERA/K9, in both the live bot (`api/scan.js`) and the backtest (`scripts/backtest.js`).

**Architecture:** Two new pure functions in `lib/mlb.js` fetch and aggregate a pitcher's `yearByYear` pitching stats (deduplicating mid-season trades, filtering to regular season, cutting off at the season under analysis) into a career ERA and career K/9, or `null` if the pitcher has no prior season. Two new weight constants in `lib/signals.js`, plus two tiny formatting helpers, let both `scan.js` and `backtest.js` blend career on top of the existing `blendEraEstimates` result via a second call to the same function — no new blending function needed.

**Tech Stack:** Node.js (ESM), `node:test` + `node:assert/strict`, MLB Stats API (`statsapi.mlb.com`, no auth).

**Spec:** `docs/superpowers/specs/2026-07-26-pitcher-career-stats-design.md`

---

### Task 1: `computeCareerEraBeforeSeason` / `computeCareerK9BeforeSeason` in `lib/mlb.js`

**Files:**
- Modify: `lib/mlb.js` (add functions after `fetchPitcherGameLog`, around line 96)
- Test: `lib/mlb.test.js`

This task adds the fetch function and the two aggregation functions, including the trade-deduplication logic verified against the real API (a mid-season trade produces one split per team plus a combined split with no `team` field — only the combined split must be counted, or a single-team season is double/triple counted).

- [ ] **Step 1: Write the failing tests**

Add to `lib/mlb.test.js`, after the existing `computeSeasonEra`-related imports/tests (the file already imports from `./mlb.js` in several separate `import` lines — add a new one rather than editing existing lines):

```js
import { computeCareerEraBeforeSeason, computeCareerK9BeforeSeason } from './mlb.js';
```

Add this fixture and these tests at the end of `lib/mlb.test.js`:

```js
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

test('computeCareerK9BeforeSeason: sums strikeouts and innings across prior regular seasons', () => {
  // 2022 (95 K, 90 IP) + 2023 combined (120 K, 110 IP) = 215 K, 200 IP -> 215*9/200 = 9.675
  const k9 = computeCareerK9BeforeSeason(YEAR_BY_YEAR_PITCHING_FIXTURE, 2025);
  assert.ok(Math.abs(k9 - 9.675) < 1e-9);
});

test('computeCareerK9BeforeSeason: returns null when there are no qualifying prior seasons', () => {
  assert.equal(computeCareerK9BeforeSeason(YEAR_BY_YEAR_PITCHING_FIXTURE, 2022), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `computeCareerEraBeforeSeason is not a function` (or similar import error), since neither function exists yet.

- [ ] **Step 3: Implement `fetchPitcherYearByYearStats` and the dedup/aggregation helpers**

In `lib/mlb.js`, insert this immediately after `fetchPitcherGameLog` (currently ends at line 96, right before the `clamp` function):

```js
export async function fetchPitcherYearByYearStats(personId) {
  const res = await fetch(`${MLB_API}/people/${personId}/stats?stats=yearByYear&group=pitching`);
  if (!res.ok) throw new Error(`MLB pitcher year-by-year stats fetch failed: ${res.status}`);
  return res.json();
}

// A pitcher traded mid-season gets one split per team PLUS a combined split with no `team`
// field carrying that season's real total (verified against the live API: Scherzer's 2021 has
// Washington 111.0 IP + Dodgers 68.1 IP + a combined 179.1 IP split). Summing every split for a
// season with a trade would double/triple-count it, so for each season we keep only the
// combined split when one exists, and the single split otherwise.
function dedupSeasonSplits(splits) {
  const bySeason = new Map();
  for (const split of splits) {
    const season = split.season;
    const existing = bySeason.get(season);
    if (!existing || !split.team) {
      // No existing entry yet, or this split is the team-less combined one — prefer it.
      if (!existing || !split.team) bySeason.set(season, split);
    }
  }
  return [...bySeason.values()];
}

function priorRegularSeasonSplits(yearByYearResponse, beforeSeason) {
  const splits = yearByYearResponse.stats?.[0]?.splits || [];
  const regularSeason = splits.filter(s => s.gameType === 'R' && Number(s.season) < beforeSeason);
  return dedupSeasonSplits(regularSeason);
}

// Career = every regular season strictly before beforeSeason (never the season under analysis
// itself), so this is identical whether called live (beforeSeason = current year) or from the
// backtest (beforeSeason = the season being tested) — those prior seasons are equally "closed"
// either way, unlike recent-form data which needs date-scoping to stay leak-free.
export function computeCareerEraBeforeSeason(yearByYearResponse, beforeSeason) {
  const priorSplits = priorRegularSeasonSplits(yearByYearResponse, beforeSeason);
  if (priorSplits.length === 0) return null;
  const earnedRuns = priorSplits.reduce((sum, s) => sum + Number(s.stat.earnedRuns || 0), 0);
  const outs = priorSplits.reduce((sum, s) => sum + inningsPitchedToOuts(s.stat.inningsPitched || '0.0'), 0);
  const inningsPitched = outs / 3;
  if (inningsPitched === 0) return null;
  return (earnedRuns * 9) / inningsPitched;
}

export function computeCareerK9BeforeSeason(yearByYearResponse, beforeSeason) {
  const priorSplits = priorRegularSeasonSplits(yearByYearResponse, beforeSeason);
  if (priorSplits.length === 0) return null;
  const strikeOuts = priorSplits.reduce((sum, s) => sum + Number(s.stat.strikeOuts || 0), 0);
  const outs = priorSplits.reduce((sum, s) => sum + inningsPitchedToOuts(s.stat.inningsPitched || '0.0'), 0);
  const inningsPitched = outs / 3;
  if (inningsPitched === 0) return null;
  return (strikeOuts * 9) / inningsPitched;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all new tests green, all 185 previous tests still passing (192 total).

- [ ] **Step 5: Commit**

```bash
git add lib/mlb.js lib/mlb.test.js
git commit -m "feat: add career ERA/K9 aggregation from MLB yearByYear pitching stats"
```

---

### Task 2: Career blend weight constants and reasoning-note helpers in `lib/signals.js`

**Files:**
- Modify: `lib/signals.js` (add after `blendEraEstimates`, currently lines 63-65)
- Test: `lib/signals.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `lib/signals.test.js`, near the existing `blendEraEstimates` tests (around line 409, right after the "custom weight is respected" test):

```js
import { CAREER_ERA_WEIGHT, CAREER_K9_WEIGHT } from './signals.js';
import { formatCareerEraNote, formatCareerEraPairNote } from './signals.js';
```

```js
test('CAREER_ERA_WEIGHT/CAREER_K9_WEIGHT: start at 90% (10% career), cascading with blendEraEstimates', () => {
  const recentSeasonEra = blendEraEstimates(3.00, 5.00); // 3.80, as in the existing test above
  const finalEra = blendEraEstimates(recentSeasonEra, 4.00, CAREER_ERA_WEIGHT);
  // 3.80*0.9 + 4.00*0.1 = 3.82
  assert.ok(Math.abs(finalEra - 3.82) < 1e-9);
  assert.equal(CAREER_ERA_WEIGHT, 0.9);
  assert.equal(CAREER_K9_WEIGHT, 0.9);
});

test('formatCareerEraNote: returns empty string when there is no career data', () => {
  assert.equal(formatCareerEraNote(null), '');
});

test('formatCareerEraNote: formats a known career ERA', () => {
  assert.equal(formatCareerEraNote(3.845), ' (carrera: 3.85)');
});

test('formatCareerEraPairNote: returns empty string when neither side has career data', () => {
  assert.equal(formatCareerEraPairNote({ homeTeam: 'Red Sox', awayTeam: 'Yankees', homeCareerEra: null, awayCareerEra: null }), '');
});

test('formatCareerEraPairNote: formats both sides when both have career data', () => {
  const note = formatCareerEraPairNote({ homeTeam: 'Red Sox', awayTeam: 'Yankees', homeCareerEra: 3.5, awayCareerEra: 4.25 });
  assert.equal(note, ' ERA de carrera: Red Sox 3.50, Yankees 4.25.');
});

test('formatCareerEraPairNote: labels the side without data as "sin datos"', () => {
  const note = formatCareerEraPairNote({ homeTeam: 'Red Sox', awayTeam: 'Yankees', homeCareerEra: 3.5, awayCareerEra: null });
  assert.equal(note, ' ERA de carrera: Red Sox 3.50, Yankees sin datos.');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `CAREER_ERA_WEIGHT` import errors / `formatCareerEraNote is not a function`.

- [ ] **Step 3: Implement the constants and helpers**

In `lib/signals.js`, insert this immediately after `blendEraEstimates` (currently lines 63-65, right before the `projectedTotalRuns` comment block):

```js
// Weight given to the RECENT+SEASON blend (from blendEraEstimates) when it's re-blended against
// a pitcher's career ERA/K9 (all regular seasons strictly before the current one) — i.e. career
// starts at 10% influence. Starting point only: re-measure via the backtest, same as
// LEAGUE_AVG_TOP_WEIGHTED_OPS above. When a pitcher has no prior season (rookie), this constant
// is unused for him — the caller skips the second blendEraEstimates call entirely.
export const CAREER_ERA_WEIGHT = 0.9;
export const CAREER_K9_WEIGHT = 0.9;

export function formatCareerEraNote(careerEra) {
  return careerEra == null ? '' : ` (carrera: ${careerEra.toFixed(2)})`;
}

export function formatCareerEraPairNote({ homeTeam, awayTeam, homeCareerEra, awayCareerEra }) {
  if (homeCareerEra == null && awayCareerEra == null) return '';
  const homeLabel = homeCareerEra != null ? homeCareerEra.toFixed(2) : 'sin datos';
  const awayLabel = awayCareerEra != null ? awayCareerEra.toFixed(2) : 'sin datos';
  return ` ERA de carrera: ${homeTeam} ${homeLabel}, ${awayTeam} ${awayLabel}.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — new tests green, all previous tests still passing.

- [ ] **Step 5: Commit**

```bash
git add lib/signals.js lib/signals.test.js
git commit -m "feat: add career-blend weight constants and reasoning-note helpers"
```

---

### Task 3: Integrate career ERA/K9 into `api/scan.js` (live bot)

**Files:**
- Modify: `api/scan.js`

No new tests here — `scan.js` does live network I/O and isn't part of the pure-logic test suite (per `package.json`'s `node --test lib/**/*.test.js`), same as every other function already in this file. Correctness is covered by Tasks 1-2's unit tests plus manual verification in Task 6.

- [ ] **Step 1: Update imports**

In `api/scan.js`, replace this import block (lines 4-14):

```js
import {
  fetchSchedule, parseScheduleGames, fetchStandings, parseLastTenRecord,
  fetchPitcherGameLog, computeRecentEra, computeSeasonEra, extractPitcherName,
  fetchTeamRoster, parseRoster,
  fetchBatterSeasonStats,
  fetchPitcherSeasonStats, extractStrikeoutsPer9, extractInningsPerStart, computeRecentStrikeoutsPer9,
  fetchPersonInfo, extractPitchHand,
  extractTeamStrikeoutRate, fetchBatterHittingVsHand, computeAverageStrikeoutRate,
  fetchTeamSeasonHitting, fetchTeamRecentHitting, extractRunsPerGame, extractOpsFromHittingStats,
  fetchTeamRecentSchedule, findMostRecentFinalGamePk, extractStartingLineup, fetchGameBoxscore,
  fetchGameFeed, extractWeather, extractPowerContactProfile,
} from '../lib/mlb.js';
```

with:

```js
import {
  fetchSchedule, parseScheduleGames, fetchStandings, parseLastTenRecord,
  fetchPitcherGameLog, computeRecentEra, computeSeasonEra, extractPitcherName,
  fetchPitcherYearByYearStats, computeCareerEraBeforeSeason, computeCareerK9BeforeSeason,
  fetchTeamRoster, parseRoster,
  fetchBatterSeasonStats,
  fetchPitcherSeasonStats, extractStrikeoutsPer9, extractInningsPerStart, computeRecentStrikeoutsPer9,
  fetchPersonInfo, extractPitchHand,
  extractTeamStrikeoutRate, fetchBatterHittingVsHand, computeAverageStrikeoutRate,
  fetchTeamSeasonHitting, fetchTeamRecentHitting, extractRunsPerGame, extractOpsFromHittingStats,
  fetchTeamRecentSchedule, findMostRecentFinalGamePk, extractStartingLineup, fetchGameBoxscore,
  fetchGameFeed, extractWeather, extractPowerContactProfile,
} from '../lib/mlb.js';
```

Replace this import block (lines 16-21):

```js
import {
  moneylineEstimate, projectedTotalRuns, projectedFirstFiveInningsRuns, overProbability, overProbabilityProp,
  impliedProbability, edge, isSignal, formatSignalMessage,
  expectedPitcherStrikeouts, blendEraEstimates, computeOffensiveFactor, computeLineupOps, LEAGUE_AVG_TOP_WEIGHTED_OPS,
  computeAveragePowerContactFactor, adjustedInningsForEarlyHookRisk, computeWeatherFactorForStrikeouts,
} from '../lib/signals.js';
```

with:

```js
import {
  moneylineEstimate, projectedTotalRuns, projectedFirstFiveInningsRuns, overProbability, overProbabilityProp,
  impliedProbability, edge, isSignal, formatSignalMessage,
  expectedPitcherStrikeouts, blendEraEstimates, computeOffensiveFactor, computeLineupOps, LEAGUE_AVG_TOP_WEIGHTED_OPS,
  computeAveragePowerContactFactor, adjustedInningsForEarlyHookRisk, computeWeatherFactorForStrikeouts,
  CAREER_ERA_WEIGHT, CAREER_K9_WEIGHT, formatCareerEraNote, formatCareerEraPairNote,
} from '../lib/signals.js';
```

- [ ] **Step 2: Fetch each pitcher's year-by-year stats alongside the game log**

Replace this destructured `Promise.all` (lines 127-146):

```js
      const [
        homeGameLog, awayGameLog,
        homeSeasonHittingRaw, awaySeasonHittingRaw,
        homeRecentHittingRaw, awayRecentHittingRaw,
        homePersonInfoRaw, awayPersonInfoRaw,
        homeRosterRaw, awayRosterRaw, homeLineup, awayLineup,
      ] = await Promise.all([
        homePitcherId ? fetchPitcherGameLog(homePitcherId, SEASON) : Promise.resolve(null),
        awayPitcherId ? fetchPitcherGameLog(awayPitcherId, SEASON) : Promise.resolve(null),
        fetchTeamSeasonHitting(game.homeTeamId, SEASON),
        fetchTeamSeasonHitting(game.awayTeamId, SEASON),
        fetchTeamRecentHitting(game.homeTeamId, SEASON, recentStartDate, recentEndDate),
        fetchTeamRecentHitting(game.awayTeamId, SEASON, recentStartDate, recentEndDate),
        homePitcherId ? fetchPersonInfo(homePitcherId) : Promise.resolve(null),
        awayPitcherId ? fetchPersonInfo(awayPitcherId) : Promise.resolve(null),
        fetchTeamRoster(game.homeTeamId),
        fetchTeamRoster(game.awayTeamId),
        fetchRecentLineup(game.homeTeamId, today),
        fetchRecentLineup(game.awayTeamId, today),
      ]);
```

with:

```js
      const [
        homeGameLog, awayGameLog,
        homeYearByYearRaw, awayYearByYearRaw,
        homeSeasonHittingRaw, awaySeasonHittingRaw,
        homeRecentHittingRaw, awayRecentHittingRaw,
        homePersonInfoRaw, awayPersonInfoRaw,
        homeRosterRaw, awayRosterRaw, homeLineup, awayLineup,
      ] = await Promise.all([
        homePitcherId ? fetchPitcherGameLog(homePitcherId, SEASON) : Promise.resolve(null),
        awayPitcherId ? fetchPitcherGameLog(awayPitcherId, SEASON) : Promise.resolve(null),
        homePitcherId ? fetchPitcherYearByYearStats(homePitcherId) : Promise.resolve(null),
        awayPitcherId ? fetchPitcherYearByYearStats(awayPitcherId) : Promise.resolve(null),
        fetchTeamSeasonHitting(game.homeTeamId, SEASON),
        fetchTeamSeasonHitting(game.awayTeamId, SEASON),
        fetchTeamRecentHitting(game.homeTeamId, SEASON, recentStartDate, recentEndDate),
        fetchTeamRecentHitting(game.awayTeamId, SEASON, recentStartDate, recentEndDate),
        homePitcherId ? fetchPersonInfo(homePitcherId) : Promise.resolve(null),
        awayPitcherId ? fetchPersonInfo(awayPitcherId) : Promise.resolve(null),
        fetchTeamRoster(game.homeTeamId),
        fetchTeamRoster(game.awayTeamId),
        fetchRecentLineup(game.homeTeamId, today),
        fetchRecentLineup(game.awayTeamId, today),
      ]);
```

- [ ] **Step 3: Blend career ERA into the final ERA used everywhere**

Replace (lines 148-153):

```js
      const homeEra = homeGameLog ? computeRecentEra(homeGameLog) : 4.00;
      const awayEra = awayGameLog ? computeRecentEra(awayGameLog) : 4.00;
      const homeSeasonEra = homeGameLog ? computeSeasonEra(homeGameLog) : 4.00;
      const awaySeasonEra = awayGameLog ? computeSeasonEra(awayGameLog) : 4.00;
      const homeBlendedEra = blendEraEstimates(homeEra, homeSeasonEra);
      const awayBlendedEra = blendEraEstimates(awayEra, awaySeasonEra);
```

with:

```js
      const homeEra = homeGameLog ? computeRecentEra(homeGameLog) : 4.00;
      const awayEra = awayGameLog ? computeRecentEra(awayGameLog) : 4.00;
      const homeSeasonEra = homeGameLog ? computeSeasonEra(homeGameLog) : 4.00;
      const awaySeasonEra = awayGameLog ? computeSeasonEra(awayGameLog) : 4.00;
      const homeCareerEra = homeYearByYearRaw ? computeCareerEraBeforeSeason(homeYearByYearRaw, SEASON) : null;
      const awayCareerEra = awayYearByYearRaw ? computeCareerEraBeforeSeason(awayYearByYearRaw, SEASON) : null;
      const homeRecentSeasonEra = blendEraEstimates(homeEra, homeSeasonEra);
      const awayRecentSeasonEra = blendEraEstimates(awayEra, awaySeasonEra);
      const homeBlendedEra = homeCareerEra == null ? homeRecentSeasonEra : blendEraEstimates(homeRecentSeasonEra, homeCareerEra, CAREER_ERA_WEIGHT);
      const awayBlendedEra = awayCareerEra == null ? awayRecentSeasonEra : blendEraEstimates(awayRecentSeasonEra, awayCareerEra, CAREER_ERA_WEIGHT);
```

`homeBlendedEra`/`awayBlendedEra` already feed moneyline, totals, F5, and the strikeout market's `ownEra` — no other call sites need to change for ERA.

- [ ] **Step 4: Add the career ERA note to the moneyline and totals/F5 reasoning text**

Replace this line inside the moneyline reasoning template (currently one long line, ~line 193):

```js
        const reasoning = `El modelo compara el pitcheo (ERA de temporada + últimos 5 arranques), la forma reciente en el récord, y qué tan bien está bateando cada lineup titular contra la mano del pitcher rival. Abridor de ${game.homeTeam}: ${homePitcherName}, ERA de temporada ${homeSeasonEra.toFixed(2)} y reciente ${homeEra.toFixed(2)}. Abridor de ${game.awayTeam}: ${awayPitcherName}, ERA de temporada ${awaySeasonEra.toFixed(2)} y reciente ${awayEra.toFixed(2)}. Forma reciente: ${game.homeTeam} lleva ${(homeLast10 * 10).toFixed(0)}-${(10 - homeLast10 * 10).toFixed(0)} en sus últimos 10 juegos, ${game.awayTeam} ${(awayLast10 * 10).toFixed(0)}-${(10 - awayLast10 * 10).toFixed(0)}. El lineup titular de ${game.homeTeam} batea para ${homeLineupOps.toFixed(3)} de OPS contra pitchers de esa mano, el de ${game.awayTeam} para ${awayLineupOps.toFixed(3)}. Con todo esto, el modelo calcula que ${team} tiene más probabilidad de ganar de la que refleja la cuota de la casa.`;
```

with:

```js
        const reasoning = `El modelo compara el pitcheo (ERA de temporada + últimos 5 arranques + carrera), la forma reciente en el récord, y qué tan bien está bateando cada lineup titular contra la mano del pitcher rival. Abridor de ${game.homeTeam}: ${homePitcherName}, ERA de temporada ${homeSeasonEra.toFixed(2)}${formatCareerEraNote(homeCareerEra)} y reciente ${homeEra.toFixed(2)}. Abridor de ${game.awayTeam}: ${awayPitcherName}, ERA de temporada ${awaySeasonEra.toFixed(2)}${formatCareerEraNote(awayCareerEra)} y reciente ${awayEra.toFixed(2)}. Forma reciente: ${game.homeTeam} lleva ${(homeLast10 * 10).toFixed(0)}-${(10 - homeLast10 * 10).toFixed(0)} en sus últimos 10 juegos, ${game.awayTeam} ${(awayLast10 * 10).toFixed(0)}-${(10 - awayLast10 * 10).toFixed(0)}. El lineup titular de ${game.homeTeam} batea para ${homeLineupOps.toFixed(3)} de OPS contra pitchers de esa mano, el de ${game.awayTeam} para ${awayLineupOps.toFixed(3)}. Con todo esto, el modelo calcula que ${team} tiene más probabilidad de ganar de la que refleja la cuota de la casa.`;
```

Replace the totals reasoning template (~line 218):

```js
        const reasoning = `El modelo proyecta que entre ambos equipos anotarán unas ${projectedTotal.toFixed(1)} carreras en este juego. Combina el ERA de cada abridor (temporada ${homeSeasonEra.toFixed(2)}/${awaySeasonEra.toFixed(2)}, reciente ${homeEra.toFixed(2)}/${awayEra.toFixed(2)}), el promedio de carreras de cada ofensiva combinando temporada completa y últimos 15 días (${game.homeTeam}: ${homeBlendedRunsPerGame.toFixed(2)}, ${game.awayTeam}: ${awayBlendedRunsPerGame.toFixed(2)}), y qué tan bien batea el lineup titular de cada equipo contra la mano del pitcher rival (${game.homeTeam}: ${homeLineupOps.toFixed(3)} OPS, ${game.awayTeam}: ${awayLineupOps.toFixed(3)} OPS). La casa de apuestas puso la línea de total de carreras en ${line.point}. Como la proyección del modelo queda ${side === 'Over' ? 'por encima' : 'por debajo'} de esa línea, el modelo ve valor en el ${side === 'Over' ? 'Over (más carreras)' : 'Under (menos carreras)'}.`;
```

with:

```js
        const reasoning = `El modelo proyecta que entre ambos equipos anotarán unas ${projectedTotal.toFixed(1)} carreras en este juego. Combina el ERA de cada abridor (temporada ${homeSeasonEra.toFixed(2)}/${awaySeasonEra.toFixed(2)}, reciente ${homeEra.toFixed(2)}/${awayEra.toFixed(2)}), el promedio de carreras de cada ofensiva combinando temporada completa y últimos 15 días (${game.homeTeam}: ${homeBlendedRunsPerGame.toFixed(2)}, ${game.awayTeam}: ${awayBlendedRunsPerGame.toFixed(2)}), y qué tan bien batea el lineup titular de cada equipo contra la mano del pitcher rival (${game.homeTeam}: ${homeLineupOps.toFixed(3)} OPS, ${game.awayTeam}: ${awayLineupOps.toFixed(3)} OPS).${formatCareerEraPairNote({ homeTeam: game.homeTeam, awayTeam: game.awayTeam, homeCareerEra, awayCareerEra })} La casa de apuestas puso la línea de total de carreras en ${line.point}. Como la proyección del modelo queda ${side === 'Over' ? 'por encima' : 'por debajo'} de esa línea, el modelo ve valor en el ${side === 'Over' ? 'Over (más carreras)' : 'Under (menos carreras)'}.`;
```

Replace the F5 totals reasoning template (~line 259):

```js
              const reasoning = `El modelo proyecta ${projectedF5Total.toFixed(1)} carreras combinadas en las primeras 5 entradas (antes de que entre el bullpen de cualquiera de los dos equipos), usando el ERA de cada abridor (temporada ${homeSeasonEra.toFixed(2)}/${awaySeasonEra.toFixed(2)}, reciente ${homeEra.toFixed(2)}/${awayEra.toFixed(2)}) y el factor ofensivo de cada lineup contra la mano rival (${game.homeTeam}: ${homeLineupOps.toFixed(3)} OPS, ${game.awayTeam}: ${awayLineupOps.toFixed(3)} OPS). La casa puso la línea de primeras 5 entradas en ${line.point}. Como la proyección queda ${side === 'Over' ? 'por encima' : 'por debajo'} de esa línea, el modelo ve valor en el ${side === 'Over' ? 'Over' : 'Under'}.`;
```

with:

```js
              const reasoning = `El modelo proyecta ${projectedF5Total.toFixed(1)} carreras combinadas en las primeras 5 entradas (antes de que entre el bullpen de cualquiera de los dos equipos), usando el ERA de cada abridor (temporada ${homeSeasonEra.toFixed(2)}/${awaySeasonEra.toFixed(2)}, reciente ${homeEra.toFixed(2)}/${awayEra.toFixed(2)}) y el factor ofensivo de cada lineup contra la mano rival (${game.homeTeam}: ${homeLineupOps.toFixed(3)} OPS, ${game.awayTeam}: ${awayLineupOps.toFixed(3)} OPS).${formatCareerEraPairNote({ homeTeam: game.homeTeam, awayTeam: game.awayTeam, homeCareerEra, awayCareerEra })} La casa puso la línea de primeras 5 entradas en ${line.point}. Como la proyección queda ${side === 'Over' ? 'por encima' : 'por debajo'} de esa línea, el modelo ve valor en el ${side === 'Over' ? 'Over' : 'Under'}.`;
```

- [ ] **Step 5: Pass each pitcher's year-by-year data into `pitcherCandidates` and blend career K9**

Replace (lines 274-283):

```js
        const pitcherCandidates = [
          {
            pitcherId: homePitcherId, pitcherName: homePitcherName, opposingRoster: awayRoster, gameLog: homeGameLog, pitchHand: homePitchHand,
            ownEra: homeBlendedEra, opposingOffensiveFactor: awayOffensiveFactor, opposingRecentHittingRaw: awayRecentHittingRaw, opposingTeamName: game.awayTeam,
          },
          {
            pitcherId: awayPitcherId, pitcherName: awayPitcherName, opposingRoster: roster, gameLog: awayGameLog, pitchHand: awayPitchHand,
            ownEra: awayBlendedEra, opposingOffensiveFactor: homeOffensiveFactor, opposingRecentHittingRaw: homeRecentHittingRaw, opposingTeamName: game.homeTeam,
          },
        ];
```

with:

```js
        const pitcherCandidates = [
          {
            pitcherId: homePitcherId, pitcherName: homePitcherName, opposingRoster: awayRoster, gameLog: homeGameLog, yearByYearRaw: homeYearByYearRaw, pitchHand: homePitchHand,
            ownEra: homeBlendedEra, opposingOffensiveFactor: awayOffensiveFactor, opposingRecentHittingRaw: awayRecentHittingRaw, opposingTeamName: game.awayTeam,
          },
          {
            pitcherId: awayPitcherId, pitcherName: awayPitcherName, opposingRoster: roster, gameLog: awayGameLog, yearByYearRaw: awayYearByYearRaw, pitchHand: awayPitchHand,
            ownEra: awayBlendedEra, opposingOffensiveFactor: homeOffensiveFactor, opposingRecentHittingRaw: homeRecentHittingRaw, opposingTeamName: game.homeTeam,
          },
        ];
```

Replace the map function's parameter list and K9 blend (lines 288-300):

```js
        await Promise.all(pitcherCandidates.map(async ({ pitcherId, pitcherName, opposingRoster, gameLog, pitchHand, ownEra, opposingOffensiveFactor, opposingRecentHittingRaw, opposingTeamName }) => {
          if (!pitcherId) return;
          try {
            const outcomes = parsePlayerPropOutcomes(propEventOdds, 'pitcher_strikeouts', pitcherName);
            if (outcomes.length === 0) return;

            const overOutcome = outcomes.find(o => o.name === 'Over');
            if (!overOutcome) return;

            const seasonStatsRaw = await fetchPitcherSeasonStats(pitcherId, SEASON);
            const seasonK9 = extractStrikeoutsPer9(seasonStatsRaw);
            const recentK9 = gameLog ? computeRecentStrikeoutsPer9(gameLog) : seasonK9;
            const pitcherK9 = blendEraEstimates(recentK9, seasonK9);
```

with:

```js
        await Promise.all(pitcherCandidates.map(async ({ pitcherId, pitcherName, opposingRoster, gameLog, yearByYearRaw, pitchHand, ownEra, opposingOffensiveFactor, opposingRecentHittingRaw, opposingTeamName }) => {
          if (!pitcherId) return;
          try {
            const outcomes = parsePlayerPropOutcomes(propEventOdds, 'pitcher_strikeouts', pitcherName);
            if (outcomes.length === 0) return;

            const overOutcome = outcomes.find(o => o.name === 'Over');
            if (!overOutcome) return;

            const seasonStatsRaw = await fetchPitcherSeasonStats(pitcherId, SEASON);
            const seasonK9 = extractStrikeoutsPer9(seasonStatsRaw);
            const recentK9 = gameLog ? computeRecentStrikeoutsPer9(gameLog) : seasonK9;
            const careerK9 = yearByYearRaw ? computeCareerK9BeforeSeason(yearByYearRaw, SEASON) : null;
            const recentSeasonK9 = blendEraEstimates(recentK9, seasonK9);
            const pitcherK9 = careerK9 == null ? recentSeasonK9 : blendEraEstimates(recentSeasonK9, careerK9, CAREER_K9_WEIGHT);
```

- [ ] **Step 6: Add the career K9 note to the strikeouts reasoning text**

Replace (~line 340):

```js
            const reasoning = `${pitcherName} es ${handLabel} y tiene ${seasonK9.toFixed(2)} ponches por cada 9 innings esta temporada (${recentK9.toFixed(2)} en sus últimos 5 arranques). Se espera que lance unas ${pitcherInningsPerStart.toFixed(1)} innings, su promedio real por arranque esta temporada.${inningsNote} Evaluamos a los bateadores del último lineup usado por ${opposingTeamName} contra pitchers ${handLabelPlural}: en promedio ponchan un ${(teamStrikeoutRate * 100).toFixed(1)}% de sus turnos (liga: ${(0.223 * 100).toFixed(1)}%), y su forma reciente en general (últimos 15 días, no solo contra esta mano) da una tasa de ${(recentOverallKRate * 100).toFixed(1)}%. La mezcla de poder (jonrones) y contacto (bateadores de buen promedio que no suelen conectar jonrón) de ese lineup ajusta la proyección ${powerContactFactor >= 1 ? 'al alza' : 'a la baja'} en un ${(Math.abs(powerContactFactor - 1) * 100).toFixed(1)}%. Factor de parque para ponches en ${game.homeTeam}: ${parkFactor.toFixed(2)}x.${weatherNote} Combinando todo esto, el modelo proyecta unos ${expectedK.toFixed(1)} ponches para ${pitcherName} en este juego. La casa puso la línea en ${overOutcome.point} — como la proyección supera esa línea, el modelo ve valor en el Over.`;
```

with:

```js
            const careerK9Note = careerK9 == null ? '' : ` (carrera: ${careerK9.toFixed(2)})`;
            const reasoning = `${pitcherName} es ${handLabel} y tiene ${seasonK9.toFixed(2)} ponches por cada 9 innings esta temporada${careerK9Note} (${recentK9.toFixed(2)} en sus últimos 5 arranques). Se espera que lance unas ${pitcherInningsPerStart.toFixed(1)} innings, su promedio real por arranque esta temporada.${inningsNote} Evaluamos a los bateadores del último lineup usado por ${opposingTeamName} contra pitchers ${handLabelPlural}: en promedio ponchan un ${(teamStrikeoutRate * 100).toFixed(1)}% de sus turnos (liga: ${(0.223 * 100).toFixed(1)}%), y su forma reciente en general (últimos 15 días, no solo contra esta mano) da una tasa de ${(recentOverallKRate * 100).toFixed(1)}%. La mezcla de poder (jonrones) y contacto (bateadores de buen promedio que no suelen conectar jonrón) de ese lineup ajusta la proyección ${powerContactFactor >= 1 ? 'al alza' : 'a la baja'} en un ${(Math.abs(powerContactFactor - 1) * 100).toFixed(1)}%. Factor de parque para ponches en ${game.homeTeam}: ${parkFactor.toFixed(2)}x.${weatherNote} Combinando todo esto, el modelo proyecta unos ${expectedK.toFixed(1)} ponches para ${pitcherName} en este juego. La casa puso la línea en ${overOutcome.point} — como la proyección supera esa línea, el modelo ve valor en el Over.`;
```

- [ ] **Step 7: Run the full test suite (regression check — `scan.js` has no direct tests, but must not break the shared `lib/` functions)**

Run: `npm test`
Expected: PASS — 192 tests (185 + 7 new from Tasks 1-2).

- [ ] **Step 8: Commit**

```bash
git add api/scan.js
git commit -m "feat: blend career ERA/K9 into the live bot's pitcher projections"
```

---

### Task 4: Integrate career ERA/K9 into `scripts/backtest.js`

**Files:**
- Modify: `scripts/backtest.js`

- [ ] **Step 1: Update imports**

Replace (lines 22-33):

```js
import {
  fetchSchedule, parseScheduleGames, fetchPitcherGameLog, filterGameLogBefore,
  computeRecentEra, computeSeasonEra, computeRecentStrikeoutsPer9, computeInningsPerStartFromGameLog,
  extractPitcherName, fetchPersonInfo, extractPitchHand,
  fetchTeamRecentSchedule, computeLastTenFromSchedule, findMostRecentFinalGamePk, extractStartingLineup, fetchGameBoxscore,
  fetchTeamRoster, parseRoster,
  fetchTeamRecentHitting, extractRunsPerGame, extractTeamStrikeoutRate,
  fetchTeamHittingByDateRangeVsHand, extractPowerContactProfile,
  fetchGameFeed, extractWeather,
  fetchGameLinescore, extractFinalScore, extractFirstFiveInningsScore, extractPlayerPitchingStrikeouts,
  fetchPlayByPlay, extractPlateAppearances,
} from '../lib/mlb.js';
```

with:

```js
import {
  fetchSchedule, parseScheduleGames, fetchPitcherGameLog, filterGameLogBefore,
  computeRecentEra, computeSeasonEra, computeRecentStrikeoutsPer9, computeInningsPerStartFromGameLog,
  extractPitcherName, fetchPersonInfo, extractPitchHand,
  fetchPitcherYearByYearStats, computeCareerEraBeforeSeason, computeCareerK9BeforeSeason,
  fetchTeamRecentSchedule, computeLastTenFromSchedule, findMostRecentFinalGamePk, extractStartingLineup, fetchGameBoxscore,
  fetchTeamRoster, parseRoster,
  fetchTeamRecentHitting, extractRunsPerGame, extractTeamStrikeoutRate,
  fetchTeamHittingByDateRangeVsHand, extractPowerContactProfile,
  fetchGameFeed, extractWeather,
  fetchGameLinescore, extractFinalScore, extractFirstFiveInningsScore, extractPlayerPitchingStrikeouts,
  fetchPlayByPlay, extractPlateAppearances,
} from '../lib/mlb.js';
```

Replace (lines 34-38):

```js
import {
  blendEraEstimates, computeOffensiveFactor, computeLineupOps, LEAGUE_AVG_TOP_WEIGHTED_OPS, moneylineEstimate, projectedTotalRuns, projectedFirstFiveInningsRuns,
  computeAveragePowerContactFactor, adjustedInningsForEarlyHookRisk, computeWeatherFactorForStrikeouts,
  expectedPitcherStrikeouts,
} from '../lib/signals.js';
```

with:

```js
import {
  blendEraEstimates, computeOffensiveFactor, computeLineupOps, LEAGUE_AVG_TOP_WEIGHTED_OPS, moneylineEstimate, projectedTotalRuns, projectedFirstFiveInningsRuns,
  computeAveragePowerContactFactor, adjustedInningsForEarlyHookRisk, computeWeatherFactorForStrikeouts,
  expectedPitcherStrikeouts, CAREER_ERA_WEIGHT, CAREER_K9_WEIGHT,
} from '../lib/signals.js';
```

- [ ] **Step 2: Add a career-stats cache alongside the existing gameLog/pitchHand caches**

Replace (lines 62-64):

```js
const gameLogCache = new Map(); // pitcherId -> raw gameLog response
const pitchHandCache = new Map(); // pitcherId -> 'L' | 'R' | null
```

with:

```js
const gameLogCache = new Map(); // pitcherId -> raw gameLog response
const pitchHandCache = new Map(); // pitcherId -> 'L' | 'R' | null
// A pitcher's prior-seasons career stats don't change day to day within a single backtest run
// (they're seasons strictly before the one being tested), so one fetch per pitcher is enough.
const yearByYearCache = new Map(); // pitcherId -> raw yearByYear response

async function getPitcherYearByYearStats(pitcherId) {
  if (!yearByYearCache.has(pitcherId)) {
    yearByYearCache.set(pitcherId, await fetchPitcherYearByYearStats(pitcherId));
  }
  return yearByYearCache.get(pitcherId);
}
```

- [ ] **Step 3: Blend career ERA/K9 into `computePitcherProfileAsOf`**

Replace (lines 86-101):

```js
async function computePitcherProfileAsOf(pitcherId, season, cutoffDate) {
  const fullLog = await getPitcherGameLog(pitcherId, season);
  const filtered = filterGameLogBefore(fullLog, cutoffDate);
  const recentK9 = computeRecentStrikeoutsPer9(filtered);
  const seasonK9 = computeRecentStrikeoutsPer9(filtered, Infinity);
  const recentEra = computeRecentEra(filtered);
  const seasonEra = computeSeasonEra(filtered);
  return {
    name: extractPitcherName(fullLog) || 'desconocido',
    blendedEra: blendEraEstimates(recentEra, seasonEra),
    seasonEra, recentEra,
    pitcherK9: blendEraEstimates(recentK9, seasonK9),
    seasonK9, recentK9,
    inningsPerStart: computeInningsPerStartFromGameLog(filtered),
  };
}
```

with:

```js
async function computePitcherProfileAsOf(pitcherId, season, cutoffDate) {
  const fullLog = await getPitcherGameLog(pitcherId, season);
  const filtered = filterGameLogBefore(fullLog, cutoffDate);
  const recentK9 = computeRecentStrikeoutsPer9(filtered);
  const seasonK9 = computeRecentStrikeoutsPer9(filtered, Infinity);
  const recentEra = computeRecentEra(filtered);
  const seasonEra = computeSeasonEra(filtered);
  const yearByYearRaw = await getPitcherYearByYearStats(pitcherId);
  const careerEra = computeCareerEraBeforeSeason(yearByYearRaw, season);
  const careerK9 = computeCareerK9BeforeSeason(yearByYearRaw, season);
  const recentSeasonEra = blendEraEstimates(recentEra, seasonEra);
  const recentSeasonK9 = blendEraEstimates(recentK9, seasonK9);
  return {
    name: extractPitcherName(fullLog) || 'desconocido',
    blendedEra: careerEra == null ? recentSeasonEra : blendEraEstimates(recentSeasonEra, careerEra, CAREER_ERA_WEIGHT),
    seasonEra, recentEra, careerEra,
    pitcherK9: careerK9 == null ? recentSeasonK9 : blendEraEstimates(recentSeasonK9, careerK9, CAREER_K9_WEIGHT),
    seasonK9, recentK9, careerK9,
    inningsPerStart: computeInningsPerStartFromGameLog(filtered),
  };
}
```

`profile.blendedEra` and `profile.pitcherK9` already flow into every downstream prediction in `processGame` (moneyline, totals, F5, strikeouts) exactly like the live bot — no other changes needed there. `careerEra`/`careerK9` are also now available on `profile` if a later session wants to store them in `factors` for miss analysis (out of scope here, per the spec).

- [ ] **Step 4: Run the full test suite (regression check — `backtest.js` has no direct tests, same reasoning as `scan.js`)**

Run: `npm test`
Expected: PASS — 192 tests, unchanged from Task 3.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest.js
git commit -m "feat: blend career ERA/K9 into the backtest's pitcher projections"
```

---

### Task 5: Update `context.md` and validate with a real backtest run

**Files:**
- Modify: `C:\Users\anton\OneDrive\Escritorio\MLB\context.md`

- [ ] **Step 1: Update the model description**

In the "El modelo — estado actual" section, in the `**Moneyline**` bullet (currently: `ERA temporada+reciente (60/40, clamp de ratio 0.4-2.2 desde esta sesión ...)`), append a sentence noting the new career layer, and add a short new bullet documenting the change, matching the file's existing style (see the "Factor ofensivo" bullet for the pattern of explaining a calibration change with its rationale). Also add an entry to the "Bugs importantes corregidos" section's "De esta sesión" list noting the mid-season-trade dedup finding, since that's the kind of subtle correctness issue that section already tracks for future sessions.

Since this file is prose maintained by hand across sessions (not code), read it fresh before editing (`docs/superpowers/specs/2026-07-26-pitcher-career-stats-design.md` has the exact wording to summarize) and edit `context.md` directly with the Edit tool at that time, rather than pre-writing the exact diff here — the surrounding sections may have shifted since this plan was written.

- [ ] **Step 2: Run a real backtest to validate the default 10% career weight**

Run: `node --env-file=.env scripts/backtest.js 2026-05-01 2026-05-31 "career ERA/K9 blend, 10% weight"`
Expected: Completes without errors, prints a run id and prediction count similar to prior runs.

- [ ] **Step 3: Compare against the existing May run in the dashboard**

Open `https://mlb-telegram-signals.vercel.app/backtest/` (secret from `.env`'s `DASHBOARD_SECRET`) and compare bias/MAE/RMSE/accuracy/Brier for moneyline and totals between this new run and the existing May run from the prior session. This is the "does 10% move anything" check called for in the spec's validation plan — if the numbers barely move, that's expected for a first pass at 10%; note the result for the next session to decide whether to try a higher weight.

- [ ] **Step 4: Commit the context.md update**

```bash
git add context.md
git commit -m "docs: document the career ERA/K9 blend layer in context.md"
```

---

### Task 6: Push and deploy

- [ ] **Step 1: Push to remote**

```bash
git push
```

- [ ] **Step 2: Deploy to production**

```bash
vercel --prod --yes
```

- [ ] **Step 3: Verify with real data**

Trigger `/senales` from Telegram (or wait for the next hourly cron) and confirm at least one signal's reasoning text now shows a "(carrera: X.XX)" note for a veteran pitcher, and that rookie/first-year pitchers' signals are unaffected (no career note, same output as before this change).

---

## Self-Review Notes

- **Spec coverage:** career ERA/K9 fetch+aggregation (Task 1), dedup-by-trade (Task 1, tested explicitly), weight constants + cascade via `blendEraEstimates` (Task 2), live bot integration (Task 3), backtest integration + caching (Task 4), reasoning-text notes (Tasks 3), rookie/no-history fallback (Tasks 1-4, tested in Task 1 and handled via `== null` checks throughout), validation plan (Task 5). Batter career OPS is explicitly out of scope per the spec and this plan.
- **No placeholders:** every step shows complete, pasteable code or an exact command with expected output, except Task 5 Step 1 which is intentionally a hand-edit of a prose file (not source code) — the plan explains why and points to the exact source (the spec) to summarize from.
- **Type/name consistency:** `computeCareerEraBeforeSeason`/`computeCareerK9BeforeSeason` (Task 1) are imported and called with identical names/signatures in Tasks 3-4. `CAREER_ERA_WEIGHT`/`CAREER_K9_WEIGHT`/`formatCareerEraNote`/`formatCareerEraPairNote` (Task 2) likewise match their usage in Task 3. `yearByYearRaw` field name is consistent between the `pitcherCandidates` construction and its destructuring in Task 3 Step 5.
