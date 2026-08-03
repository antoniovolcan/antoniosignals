export const LEAGUE_AVG_ERA = 4.00;
export const HOME_FIELD_BONUS = 0.04;

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function pitcherFactor(era, leagueAvgEra = LEAGUE_AVG_ERA) {
  const factor = leagueAvgEra / Math.max(era, 0.1);
  return clamp(factor, 0.5, 1.8);
}

// Weight given to a team's last-15-games record when blended (via blendEraEstimates, in the
// caller) against its season-to-date record into the single recordWinPct passed to
// teamWinProbability below. Deliberately season-heavy, the OPPOSITE of the pitcher ERA blend's
// recent-heavy default (blendEraEstimates' own default recentWeight=0.6): a pitcher's last 5
// starts is a meaningful, moderate sample of his current stuff, but a TEAM's last 15 games is a
// much noisier signal of true quality — even a 100-win-caliber team loses close to 40% of its
// games, so a 15-game stretch says relatively little on its own. The season-to-date record (up to
// 100+ games) is a far more reliable measure of "how good is this team really" — which is exactly
// what was missing before this: the model had no notion of a first-place team facing a last-place
// one beyond whatever their last-10 form happened to look like.
export const TEAM_RECORD_RECENT_WEIGHT = 0.3;

export function teamWinProbability({ recordWinPct, startingPitcherEra, isHome, offensiveFactor = 1.0 }) {
  const base = 0.5 * pitcherFactor(startingPitcherEra) * offensiveFactor;
  const recentAdj = (recordWinPct - 0.5) * 0.3;
  const homeAdj = isHome ? HOME_FIELD_BONUS : -HOME_FIELD_BONUS;
  return clamp(base + recentAdj + homeAdj, 0.30, 0.70);
}

export function computeOffensiveFactor({ lineupOps, leagueAvgOps = 0.720 }) {
  return clamp(lineupOps / leagueAvgOps, 0.7, 1.3);
}

// A plain lineup-wide average OPS dilutes a genuinely dangerous individual hitter into the crowd —
// backtest miss analysis showed most moneyline/totals misses came from a specific batter (already
// dangerous per his own numbers, not the team's) that the team-average missed. This still uses the
// full-lineup average (so an evenly-average lineup isn't overstated), but leans more on whichever
// batter(s) actually stand out, since real damage in a game usually comes from 1-2 hitters, not the mean.
export function computeLineupOps({ batterOpsList, topN = 2, topWeight = 0.7, leagueAvgOps = 0.720 }) {
  const valid = (batterOpsList || []).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (valid.length === 0) return leagueAvgOps;
  const lineupAvgOps = valid.reduce((sum, v) => sum + v, 0) / valid.length;
  const sorted = [...valid].sort((a, b) => b - a);
  const n = Math.min(topN, sorted.length);
  const topAvgOps = sorted.slice(0, n).reduce((sum, v) => sum + v, 0) / n;
  return blendEraEstimates(topAvgOps, lineupAvgOps, topWeight);
}

// Virtually every real lineup has internal variance (not all 9 hitters are equally good), so
// weighting toward the top hitters (computeLineupOps above) mechanically produces a HIGHER average
// than a plain lineup-wide average for almost every team — not just genuinely strong offenses.
// Comparing that against the plain league-average OPS (0.720) made nearly every team look like a
// top-tier offense, which was inflating the totals-runs projection: measured avg offensiveFactor of
// 1.17 across a month of backtest predictions (should be ~1.0). This is the correct baseline to pass
// as computeOffensiveFactor's leagueAvgOps when lineupOps came from computeLineupOps. Empirically
// measured for topN=2/topWeight=0.7 — re-measure via the backtest if those defaults ever change.
export const LEAGUE_AVG_TOP_WEIGHTED_OPS = 0.840;

export function log5(probA, probB) {
  const denom = probA + probB - 2 * probA * probB;
  if (denom === 0) return 0.5;
  return (probA - probA * probB) / denom;
}

export const LEAGUE_AVG_RUNS_PER_GAME = 4.5;

// Validated against the full 2025-season backtest (run #30), split into two independent
// holdout halves (Mar-May vs Jun-Sep): whenever the raw log5 probability favored the away team
// (<0.40), the home team actually won close to 50% of the time in BOTH halves — the model had
// essentially zero real skill in that bucket, not just noise in one month. Predictions favoring
// the home team (0.60+) were also overconfident in both halves, though less severely. This
// shrinks the final probability toward 0.5 to correct for that measured overconfidence. Starting
// point only: re-measure via the backtest (recompute the same bucket breakdown) if this constant
// is ever revisited, since the current value hasn't been swept yet the way the career weights were.
export const MONEYLINE_CALIBRATION_SHRINK = 0.5;

export function calibrateWinProbability(prob, shrink = MONEYLINE_CALIBRATION_SHRINK) {
  return clamp(0.5 + (prob - 0.5) * shrink, 0.05, 0.95);
}

export function moneylineEstimate({ home, away }) {
  const pHome = teamWinProbability({ ...home, isHome: true });
  const pAway = teamWinProbability({ ...away, isHome: false });
  return calibrateWinProbability(log5(pHome, pAway));
}

export function blendEraEstimates(recentEra, seasonEra, recentWeight = 0.6) {
  return recentEra * recentWeight + seasonEra * (1 - recentWeight);
}

// Weight given to the RECENT+SEASON blend (from blendEraEstimates) when it's re-blended against
// a pitcher's career ERA (all regular seasons strictly before the current one). May/June
// backtests at 10/20/30/40/50% career weight showed totals bias drifting steadily WORSE (further
// from zero) as career weight rose past 20%, and moneyline Brier reversing in June at 30% — so
// this stops at 20% (0.8), the last point before those reversals. Re-measure via the backtest if
// ever revisited, same as LEAGUE_AVG_TOP_WEIGHTED_OPS above. When a pitcher has no prior season
// (rookie), this constant is unused for him — the caller skips the second blendEraEstimates call.
export const CAREER_ERA_WEIGHT = 0.8;

export function formatCareerEraNote(careerEra) {
  return careerEra == null ? '' : ` (carrera: ${careerEra.toFixed(2)})`;
}

export function formatCareerEraPairNote({ homeTeam, awayTeam, homeCareerEra, awayCareerEra }) {
  if (homeCareerEra == null && awayCareerEra == null) return '';
  const homeLabel = homeCareerEra != null ? homeCareerEra.toFixed(2) : 'sin datos';
  const awayLabel = awayCareerEra != null ? awayCareerEra.toFixed(2) : 'sin datos';
  return ` ERA de carrera: ${homeTeam} ${homeLabel}, ${awayTeam} ${awayLabel}.`;
}

// Validated against the full 2025-season backtest (run #33): totals bias by projected-magnitude
// bucket was cleanly monotonic across ~2,400 predictions — low projections (<7.5 runs) came in
// UNDER the real total by +1.13 runs on average, high projections (10.5+) came in OVER by -1.82 —
// the same overconfidence shape already fixed for moneyline (calibrateWinProbability), never
// applied here. Shrinks the raw projection toward a "gravity point" (leagueAvgTotal) rather than a
// fixed number, so a park-adjusted gravity point (see projectedTotalRuns below) doesn't get
// shrunk back toward a neutral league average that wouldn't be correct for e.g. Coors Field.
// Starting point only, same as MONEYLINE_CALIBRATION_SHRINK: re-measure via the backtest.
export const TOTALS_CALIBRATION_SHRINK = 0.8;

export function calibrateProjectedTotal(projectedTotal, leagueAvgTotal, shrink = TOTALS_CALIBRATION_SHRINK) {
  return leagueAvgTotal + (projectedTotal - leagueAvgTotal) * shrink;
}

// Unlike pitcherFactor (used for moneyline, clamped to 0.5-1.8), this ratio was unclamped — a small
// sample of starts (e.g. one disastrous outing early in a pitcher's season) can produce an ERA far
// outside anything realistic for a full season (seen: 67.5), which fed straight into this formula
// and produced projections like 42 runs in a single game. Clamped to a still-wide but sane range.
//
// parkFactor (default neutral 1.0) scales the raw runs-projection for the park the game is played
// in (see RUN_PARK_FACTORS in parkFactors.js) — added after the same backtest run showed Colorado
// Rockies with by far the largest per-team totals bias (+1.8 runs under-projected), the real-world
// Coors Field effect this had zero adjustment for before. The calibration shrink above pulls toward
// a park-adjusted gravity point (LEAGUE_AVG_RUNS_PER_GAME * 2 * parkFactor), not a fixed neutral
// number, so a genuinely higher-scoring park doesn't get shrunk back down toward league-neutral.
export function projectedTotalRuns({ home, away, parkFactor = 1.0 }) {
  const awayEraRatio = clamp(away.startingPitcherEra / LEAGUE_AVG_ERA, 0.4, 2.2);
  const homeEraRatio = clamp(home.startingPitcherEra / LEAGUE_AVG_ERA, 0.4, 2.2);
  const homeExpected = (home.runsPerGame + LEAGUE_AVG_RUNS_PER_GAME * awayEraRatio) / 2;
  const awayExpected = (away.runsPerGame + LEAGUE_AVG_RUNS_PER_GAME * homeEraRatio) / 2;
  const rawTotal = (homeExpected + awayExpected) * parkFactor;
  return calibrateProjectedTotal(rawTotal, LEAGUE_AVG_RUNS_PER_GAME * 2 * parkFactor);
}

// First 5 innings mostly reflects the two starting pitchers (bullpen hasn't entered yet), so this
// scales the same runsPerGame/ERA-ratio formula down to a 5-inning baseline instead of trying to
// model bullpen usage. A rough linear scaling (5/9 of a full game) — not exact (starters often
// pitch better than the league-average reliever mix later in games), but a reasonable first pass,
// tunable via the backtest like everything else here.
export const LEAGUE_AVG_RUNS_FIRST_5 = LEAGUE_AVG_RUNS_PER_GAME * (5 / 9);
const FULL_GAME_TO_FIRST_5_RATIO = 5 / 9;

export function projectedFirstFiveInningsRuns({ home, away, parkFactor = 1.0 }) {
  const awayEraRatio = clamp(away.startingPitcherEra / LEAGUE_AVG_ERA, 0.4, 2.2);
  const homeEraRatio = clamp(home.startingPitcherEra / LEAGUE_AVG_ERA, 0.4, 2.2);
  const homeExpected = (home.runsPerGame * FULL_GAME_TO_FIRST_5_RATIO + LEAGUE_AVG_RUNS_FIRST_5 * awayEraRatio) / 2;
  const awayExpected = (away.runsPerGame * FULL_GAME_TO_FIRST_5_RATIO + LEAGUE_AVG_RUNS_FIRST_5 * homeEraRatio) / 2;
  const rawTotal = (homeExpected + awayExpected) * parkFactor;
  return calibrateProjectedTotal(rawTotal, LEAGUE_AVG_RUNS_FIRST_5 * 2 * parkFactor);
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

// Preferred price when choosing among several alternate-line candidates that already clear the
// edge threshold: not so cheap it's barely more than a coin flip paying out (little value even if
// "safe"), not so expensive it's chasing a speculative long shot just because the model happens to
// like it. 1.50 is where a line stops being the shorter-priced favorite side.
export const ALT_LINE_TARGET_PRICE = 1.50;

// Picks the best of several already-edge-clearing candidate lines (each needs at least a `price`):
// the cheapest price that still clears targetPrice -- e.g. among 1.46 and 1.60 with target 1.50,
// picks 1.60, not the merely-closer-by-distance 1.46, because 1.46 is on the "too safe" side of the
// target. targetPrice is a hard floor, not a preference: if nothing clears it, returns null rather
// than falling back to a cheaper line -- no signal is better than one at odds too short to be worth
// it. This never decides WHETHER a line has value -- callers must already have filtered to lines
// that pass isSignal -- it only decides which of several good lines to bet.
export function selectAlternateLine(candidates, targetPrice = ALT_LINE_TARGET_PRICE) {
  if (!candidates || candidates.length === 0) return null;
  const above = candidates.filter(c => c.price > targetPrice);
  if (above.length === 0) return null;
  return above.reduce((best, c) => (c.price < best.price ? c : best));
}

export function impliedProbability(decimalOdds) {
  return 1 / decimalOdds;
}

export function edge(estimatedProb, impliedProb) {
  return estimatedProb - impliedProb;
}

export function isSignal(estimatedProb, impliedProb, threshold = 0.05) {
  return edge(estimatedProb, impliedProb) >= threshold;
}

// Separate from isSignal/edge (which compares the model against the market's odds): this checks
// the model's OWN confidence, independent of what the market thinks. Validated against the full
// 2025-season backtest (run #31, post shrinkage/hook-risk fixes): raw moneyline accuracy across
// every game is ~54%, but restricting to games where the model's probability sits at least this
// far from a coin flip lifts it (0.06 -> 55.4% @ 61% of games, 0.10 -> 56.1% @ 37%, 0.15 -> 59.1%
// @ just 13%) — a real but modest effect, and this constant starts conservatively (keeping roughly
// half the games) rather than chasing the biggest jump at the cost of most of the volume. Meant to
// be stacked on TOP of isSignal's edge threshold in the live bot, not a replacement for it — edge
// compares against the market (which already prices in a lot), this compares against a coin flip.
export const MIN_MONEYLINE_CONFIDENCE = 0.08;

export function isConfidentEnough(estimatedProb, minDistance = MIN_MONEYLINE_CONFIDENCE) {
  return Math.abs(estimatedProb - 0.5) >= minDistance;
}

export function gradeMoneylineSignal({ selection, homeTeam, homeScore, awayScore }) {
  const homeWon = homeScore > awayScore;
  const pickedHome = selection === homeTeam;
  return pickedHome === homeWon;
}

export function gradeTotalsSignal({ selection, line, homeScore, awayScore }) {
  if (typeof line !== 'number' || !Number.isFinite(line)) return null;
  const actualTotal = homeScore + awayScore;
  const isOver = selection.startsWith('Over');
  return isOver ? actualTotal > line : actualTotal < line;
}

export function gradeOverSignal({ line, actualValue }) {
  if (typeof line !== 'number' || !Number.isFinite(line)) return null;
  return actualValue > line;
}

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

// Renders every game the other MLB-simulator project predicted for a date as one standalone
// Telegram message — unlike formatSimComparisonNote (a one-line footnote attached to a moneyline
// signal that only fires above the edge threshold), this shows the simulator's own output for
// every game regardless of whether this bot ever sent a signal for it.
export function formatSimReportMessage(date, predictions) {
  if (!predictions || predictions.length === 0) {
    return `🎲 Simulaciones del ${date}: todavía no hay predicciones del simulador para hoy.`;
  }
  const lines = predictions.map(p => {
    const homePct = (p.homeWinPct * 100).toFixed(1);
    const awayPct = (p.awayWinPct * 100).toFixed(1);
    const homePitcherNote = p.homePitcher ? ` (${p.homePitcher})` : '';
    const awayPitcherNote = p.awayPitcher ? ` (${p.awayPitcher})` : '';
    return `${p.awayTeam} @ ${p.homeTeam}\n  ${p.homeTeam} ${homePct}%${homePitcherNote} — ${p.awayTeam} ${awayPct}%${awayPitcherNote}`;
  });
  return `🎲 SIMULACIONES DEL DÍA — ${date} (${predictions.length} juego${predictions.length === 1 ? '' : 's'})\n\n${lines.join('\n\n')}`;
}

export function formatSignalMessage({ matchup, market, selection, price, impliedProb, estimatedProb, edgeValue, reasoning, emoji = '⚾' }) {
  return `${emoji} ${matchup}\n` +
    `📊 ${market}: ${selection}\n\n` +
    `💰 Cuota: ${price.toFixed(2)} (implícita ${(impliedProb * 100).toFixed(1)}%)\n` +
    `📈 Probabilidad estimada: ${(estimatedProb * 100).toFixed(1)}%\n` +
    `🔥 Edge: ${edgeValue >= 0 ? '+' : ''}${(edgeValue * 100).toFixed(1)}%\n\n` +
    `📝 ${reasoning}`;
}
