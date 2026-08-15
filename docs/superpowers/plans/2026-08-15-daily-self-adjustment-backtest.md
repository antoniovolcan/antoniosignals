# Daily Self-Adjustment Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone analysis script that walk-forward simulates the moneyline model auto-adjusting its 7 continuous parameters once per day via numerical gradient descent on Brier score, starting from production values, and report whether this beats the static baseline over the 2025 season.

**Architecture:** Single Node ESM script at the repo root (same pattern as this session's `candidate_*.js` scripts), reading already-captured `factors` from Supabase run #50 (moneyline, full season) via `getBacktestPredictions`, reconstructing the real `lib/signals.js` prediction pipeline with parameterized constants, then replaying days in chronological order with a per-day gradient step.

**Tech Stack:** Node.js (`--env-file=.env`), `@supabase/supabase-js`, direct imports from `lib/signals.js` and `lib/db.js` — no new dependencies.

## Global Constraints

- Analysis only — this plan does not modify `lib/signals.js`, `api/scan.js`, or `scripts/backtest.js`. No production code changes.
- The script is a throwaway scratch file (matches this session's established `candidate_*.js` convention) — not committed to git. Delete it after results are captured and documented.
- Every simulation must start by verifying its baseline (learning rate = 0) reproduces run #50's real stored accuracy (0.5599505562422744, n=2427) exactly, before trusting any gradient-descent output — same discipline used for every prior candidate this session, after the streak-bonus bug taught this the hard way.
- Data source: Supabase `backtest_predictions`, `run_id=50`, `market='moneyline'` (already has `homeSeasonEra`/`homeRecentEra`/`homeCareerEra`, `homeSeasonWinPct`/`homeRecentWinPct`, `homeOffensiveFactor`, `homeStartsCount` and away-side equivalents, per game, for the full 2025-03-25 to 2025-09-28 season).
- Reuse real functions from `lib/signals.js` (`clamp`, `pitcherFactor`, `log5`, `blendEraEstimates`, `calibrateWinProbability`, `applyThinSampleDampening`) rather than reimplementing them — only `teamWinProbability`'s formula needs a parameterized reimplementation (it hardcodes module constants), matching the pattern already validated in `candidate_v3.js`/`candidate_bullpen.js` earlier this session.

---

### Task 1: Data loading + parameterized prediction pipeline, baseline-verified

**Files:**
- Create: `candidate_self_adjust.js` (repo root, not committed)

**Interfaces:**
- Produces: `simulate(row, params)` — takes one normalized prediction row and a `params` object with keys `{ homeFieldBonus, recordAdjScale, clampLo, clampHi, careerWeight, recentWeight, shrink }`, returns a probability in `[0.05, 0.95]`.
- Produces: `brierOf(rows, params)` — returns `{ n, brier, accuracy }` over a list of rows.
- Produces: `PROD` — the production-default params object.
- Produces: `groupByDate(rows)` — returns a `Map<string, rows[]>` keyed by `gameDate`, iterable in ascending chronological order.

- [ ] **Step 1: Fetch run #50 moneyline predictions and normalize**

```javascript
import { createClient } from '@supabase/supabase-js';
import { getBacktestPredictions } from './lib/db.js';
import {
  clamp, pitcherFactor, log5, blendEraEstimates,
  calibrateWinProbability, applyThinSampleDampening,
} from './lib/signals.js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const RUN_ID = 50;
const rawRows = await getBacktestPredictions(db, { runId: RUN_ID, market: 'moneyline' });
const rows = rawRows.map(r => ({
  gameDate: r.game_date,
  actualOutcome: r.actual_outcome,
  factors: r.factors,
  projectedProb: r.projected_prob,
}));
console.log(`fetched ${rows.length} moneyline predictions from run ${RUN_ID}`);
```

- [ ] **Step 2: Implement the parameterized prediction pipeline**

```javascript
function reconstructMoneylineEra(seasonEra, recentEra, careerEra, careerWeight) {
  const recentSeasonEra = blendEraEstimates(recentEra, seasonEra);
  return careerEra == null ? recentSeasonEra : blendEraEstimates(recentSeasonEra, careerEra, careerWeight);
}

function teamWinProbP({ recordWinPct, startingPitcherEra, isHome, offensiveFactor }, p) {
  const base = 0.5 * pitcherFactor(startingPitcherEra) * offensiveFactor;
  const recentAdj = (recordWinPct - 0.5) * p.recordAdjScale;
  const homeAdj = isHome ? p.homeFieldBonus : -p.homeFieldBonus;
  return clamp(base + recentAdj + homeAdj, p.clampLo, p.clampHi);
}

function simulate(row, p) {
  const f = row.factors;
  const homeEra = f.homeMoneylineEra ?? reconstructMoneylineEra(f.homeSeasonEra, f.homeRecentEra, f.homeCareerEra, p.careerWeight);
  const awayEra = f.awayMoneylineEra ?? reconstructMoneylineEra(f.awaySeasonEra, f.awayRecentEra, f.awayCareerEra, p.careerWeight);
  const homeRecordWinPct = f.homeRecentWinPct * p.recentWeight + f.homeSeasonWinPct * (1 - p.recentWeight);
  const awayRecordWinPct = f.awayRecentWinPct * p.recentWeight + f.awaySeasonWinPct * (1 - p.recentWeight);
  const pHome = teamWinProbP({ recordWinPct: homeRecordWinPct, startingPitcherEra: homeEra, isHome: true, offensiveFactor: f.homeOffensiveFactor }, p);
  const pAway = teamWinProbP({ recordWinPct: awayRecordWinPct, startingPitcherEra: awayEra, isHome: false, offensiveFactor: f.awayOffensiveFactor }, p);
  let calibrated = calibrateWinProbability(log5(pHome, pAway), p.shrink);
  const favoredStartsCount = calibrated > 0.5 ? f.homeStartsCount : f.awayStartsCount;
  return applyThinSampleDampening(calibrated, favoredStartsCount);
}

const PROD = {
  homeFieldBonus: 0.09, recordAdjScale: 0.5, clampLo: 0.20, clampHi: 0.80,
  careerWeight: 0.15, recentWeight: 0.3, shrink: 0.5,
};

function brierOf(rowsList, p) {
  let n = 0, correct = 0, brierSum = 0;
  for (const row of rowsList) {
    const prob = simulate(row, p);
    n++;
    if ((prob > 0.5) === row.actualOutcome) correct++;
    brierSum += (prob - (row.actualOutcome ? 1 : 0)) ** 2;
  }
  return { n, accuracy: n ? correct / n : null, brier: n ? brierSum / n : null };
}
```

- [ ] **Step 3: Verify the baseline matches run #50's real stored accuracy exactly**

```javascript
console.log('\n=== verify baseline matches real ===');
const reconstructed = brierOf(rows, PROD);
console.log('reconstructed:', reconstructed);
const stored = rows.reduce((acc, r) => {
  acc.n++;
  if ((r.projectedProb > 0.5) === r.actualOutcome) acc.c++;
  return acc;
}, { n: 0, c: 0 });
console.log('stored real:', stored.c / stored.n, 'n=', stored.n);
if (Math.abs(reconstructed.accuracy - stored.c / stored.n) > 1e-9) {
  throw new Error('Baseline mismatch -- do not trust anything past this point until fixed.');
}
console.log('BASELINE VERIFIED EXACT MATCH.');
```

Run: `node --env-file=.env candidate_self_adjust.js`
Expected output: `reconstructed: { n: 2427, accuracy: 0.5599505562422744, ... }` and `stored real: 0.5599505562422744 n= 2427`, followed by `BASELINE VERIFIED EXACT MATCH.` with no thrown error.

- [ ] **Step 4: Implement `groupByDate` and confirm chronological ordering**

```javascript
function groupByDate(rowsList) {
  const map = new Map();
  for (const row of rowsList) {
    if (!map.has(row.gameDate)) map.set(row.gameDate, []);
    map.get(row.gameDate).push(row);
  }
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

const byDate = groupByDate(rows);
const dateKeys = [...byDate.keys()];
console.log(`\n${dateKeys.length} distinct game dates, first=${dateKeys[0]}, last=${dateKeys[dateKeys.length - 1]}`);
```

Run: `node --env-file=.env candidate_self_adjust.js`
Expected: a date count roughly matching the number of days games were played between 2025-03-25 and 2025-09-28 (well under the ~188 calendar days in that span, since off-days have zero games), first date `2025-03-25` or the first date with games, last date on or before `2025-09-28`.

- [ ] **Step 5: No commit** — `candidate_self_adjust.js` is a scratch file per Global Constraints; do not `git add` it. Proceed directly to Task 2 in the same file.

---

### Task 2: Numerical gradient-descent update loop

**Files:**
- Modify: `candidate_self_adjust.js` (append to the file from Task 1)

**Interfaces:**
- Consumes: `simulate(row, params)`, `brierOf(rows, params)`, `PROD`, `groupByDate(rows)` from Task 1.
- Produces: `runSelfAdjustment(byDate, initialParams, learningRate)` — returns `{ finalParams, trajectory, dailyLog }` where `trajectory` is an array of `{ date, params: {...} }` snapshots (one per day, taken *after* that day's update) and `dailyLog` is an array of `{ date, n, correct, brierBefore }` (the day's own accuracy/Brier measured with the params in effect *before* that day's update, i.e. the actual walk-forward prediction quality).

- [ ] **Step 1: Implement the per-day finite-difference gradient step**

```javascript
const PARAM_KEYS = ['homeFieldBonus', 'recordAdjScale', 'clampLo', 'clampHi', 'careerWeight', 'recentWeight', 'shrink'];
const EPSILON = 1e-4;
// Keeps each parameter inside a sane range regardless of where gradient descent tries to push it.
const PARAM_BOUNDS = {
  homeFieldBonus: [0, 0.35],
  recordAdjScale: [0, 2.0],
  clampLo: [0.02, 0.45],
  clampHi: [0.55, 0.98],
  careerWeight: [0, 0.6],
  recentWeight: [0, 1],
  shrink: [0.1, 1.5],
};

function clampParam(key, value) {
  const [lo, hi] = PARAM_BOUNDS[key];
  return Math.min(Math.max(value, lo), hi);
}

function dailyGradientStep(dayRows, params, learningRate) {
  const next = { ...params };
  const baseBrier = brierOf(dayRows, params).brier;
  for (const key of PARAM_KEYS) {
    const perturbed = { ...params, [key]: params[key] + EPSILON };
    const perturbedBrier = brierOf(dayRows, perturbed).brier;
    const gradient = (perturbedBrier - baseBrier) / EPSILON;
    next[key] = clampParam(key, params[key] - learningRate * gradient);
  }
  // clampLo must stay below clampHi with margin, regardless of where the two independently drifted.
  if (next.clampLo >= next.clampHi - 0.05) {
    next.clampLo = params.clampLo;
    next.clampHi = params.clampHi;
  }
  return next;
}
```

- [ ] **Step 2: Implement the full walk-forward loop**

```javascript
function runSelfAdjustment(byDate, initialParams, learningRate) {
  let params = { ...initialParams };
  const trajectory = [];
  const dailyLog = [];
  for (const [date, dayRows] of byDate) {
    // Measure this day's prediction quality with YESTERDAY's params (this is the actual
    // walk-forward accuracy) before updating for tomorrow.
    let correct = 0;
    for (const row of dayRows) {
      const prob = simulate(row, params);
      if ((prob > 0.5) === row.actualOutcome) correct++;
    }
    dailyLog.push({ date, n: dayRows.length, correct, brierBefore: brierOf(dayRows, params).brier });
    params = dailyGradientStep(dayRows, params, learningRate);
    trajectory.push({ date, params: { ...params } });
  }
  return { finalParams: params, trajectory, dailyLog };
}
```

- [ ] **Step 3: Smoke-test with a tiny learning rate and confirm params barely move**

```javascript
console.log('\n=== smoke test: learningRate=0 should exactly match static baseline ===');
const zeroLR = runSelfAdjustment(byDate, PROD, 0);
const zeroLRTotal = zeroLR.dailyLog.reduce((acc, d) => { acc.n += d.n; acc.correct += d.correct; return acc; }, { n: 0, correct: 0 });
console.log('learningRate=0 accuracy:', zeroLRTotal.correct / zeroLRTotal.n, '(must equal', reconstructed.accuracy, ')');
if (Math.abs(zeroLRTotal.correct / zeroLRTotal.n - reconstructed.accuracy) > 1e-9) {
  throw new Error('learningRate=0 must reproduce the static baseline exactly -- gradient loop has a bug.');
}
console.log('SMOKE TEST PASSED.');
```

Run: `node --env-file=.env candidate_self_adjust.js`
Expected: `SMOKE TEST PASSED.` with no thrown error. This is the critical correctness check for Task 2 — a learning rate of exactly 0 must produce identical per-day predictions to the static model, since the params never move.

---

### Task 3: Run the experiment across learning rates and report

**Files:**
- Modify: `candidate_self_adjust.js` (append to the file from Tasks 1-2)
- Modify: `context.md` (append findings)

**Interfaces:**
- Consumes: `runSelfAdjustment`, `PROD`, `byDate`, `PARAM_KEYS` from Tasks 1-2.
- Produces: console report per learning rate; a new dated section in `context.md`.

- [ ] **Step 1: Run the walk-forward self-adjustment for 3 learning rates and report accuracy split by season half**

```javascript
console.log('\n=== self-adjustment experiment across learning rates ===');
function splitAccuracy(dailyLog, fromDate, toDate) {
  let n = 0, correct = 0;
  for (const d of dailyLog) {
    if (fromDate && d.date < fromDate) continue;
    if (toDate && d.date > toDate) continue;
    n += d.n;
    correct += d.correct;
  }
  return { n, accuracy: n ? correct / n : null };
}

for (const lr of [0.001, 0.005, 0.02]) {
  const result = runSelfAdjustment(byDate, PROD, lr);
  const full = splitAccuracy(result.dailyLog);
  const marJun = splitAccuracy(result.dailyLog, undefined, '2025-06-30');
  const julSep = splitAccuracy(result.dailyLog, '2025-07-01');
  console.log(`\nlearningRate=${lr}`);
  console.log('  full season:', full);
  console.log('  Mar-Jun:', marJun);
  console.log('  Jul-Sep:', julSep);
  console.log('  final params:', result.finalParams);
  // Sample the parameter trajectory every ~30 days to show drift over time without flooding output.
  const sampled = result.trajectory.filter((_, i) => i % 30 === 0);
  console.log('  trajectory samples:', sampled.map(s => ({ date: s.date, ...s.params })));
}

console.log('\nbaseline (static, no adjustment):', reconstructed);
```

Run: `node --env-file=.env candidate_self_adjust.js`
Expected: three blocks of output (one per learning rate), each with full-season/Mar-Jun/Jul-Sep accuracy, final params, and trajectory samples, followed by the static baseline for comparison. No thrown errors.

- [ ] **Step 2: Document the findings in context.md**

Append a new section to `context.md` (after the existing "Cinco candidatos..." paragraph) summarizing, in Spanish matching the file's existing style: what was tested, the accuracy results per learning rate vs. the 55.99% static baseline (both full season and both halves), whether parameters converged or drifted, and the conclusion (does daily self-adjustment help, hurt, or do nothing here). Write the actual numbers from Step 1's output — no placeholders.

- [ ] **Step 3: Delete the scratch script**

```bash
rm -f candidate_self_adjust.js
```

- [ ] **Step 4: Commit the context.md update only**

```bash
git add context.md
git commit -m "docs: record the daily self-adjustment backtest experiment findings"
git push
```

Run: `git status --short` afterward.
Expected: clean working tree (candidate_self_adjust.js is untracked/deleted, context.md change is committed and pushed).

---

## Self-Review Notes

- **Spec coverage:** data source (Task 1), 7 parameters + fixed thin-sample params (Task 1/2, `PARAM_KEYS` matches the spec's list of 7, thin-sample untouched), gradient mechanism on Brier (Task 2), daily cadence (Task 2's per-date loop), 2-3 learning rates (Task 3), accuracy + Brier + trajectory reporting (Task 3), scratch/non-production scope (Global Constraints + Task 3 Step 3) — all covered.
- **Placeholder scan:** none found; all code blocks are complete and runnable as written.
- **Type consistency:** `params` object shape (`{ homeFieldBonus, recordAdjScale, clampLo, clampHi, careerWeight, recentWeight, shrink }`) is identical across `simulate`, `teamWinProbP`, `PROD`, `dailyGradientStep`, and `runSelfAdjustment`. `dailyLog` entry shape (`{ date, n, correct, brierBefore }`) is defined once in Task 2 Step 2 and consumed as-is in Task 3 Step 1's `splitAccuracy`.
