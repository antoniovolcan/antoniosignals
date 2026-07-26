export const LEAGUE_AVG_ERA = 4.00;
export const HOME_FIELD_BONUS = 0.04;

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function pitcherFactor(era, leagueAvgEra = LEAGUE_AVG_ERA) {
  const factor = leagueAvgEra / Math.max(era, 0.1);
  return clamp(factor, 0.5, 1.8);
}

export function teamWinProbability({ last10WinPct, startingPitcherEra, isHome, offensiveFactor = 1.0 }) {
  const base = 0.5 * pitcherFactor(startingPitcherEra) * offensiveFactor;
  const recentAdj = (last10WinPct - 0.5) * 0.3;
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

export function log5(probA, probB) {
  const denom = probA + probB - 2 * probA * probB;
  if (denom === 0) return 0.5;
  return (probA - probA * probB) / denom;
}

export const LEAGUE_AVG_RUNS_PER_GAME = 4.5;

export function moneylineEstimate({ home, away }) {
  const pHome = teamWinProbability({ ...home, isHome: true });
  const pAway = teamWinProbability({ ...away, isHome: false });
  return log5(pHome, pAway);
}

export function blendEraEstimates(recentEra, seasonEra, recentWeight = 0.6) {
  return recentEra * recentWeight + seasonEra * (1 - recentWeight);
}

// Unlike pitcherFactor (used for moneyline, clamped to 0.5-1.8), this ratio was unclamped — a small
// sample of starts (e.g. one disastrous outing early in a pitcher's season) can produce an ERA far
// outside anything realistic for a full season (seen: 67.5), which fed straight into this formula
// and produced projections like 42 runs in a single game. Clamped to a still-wide but sane range.
export function projectedTotalRuns({ home, away }) {
  const awayEraRatio = clamp(away.startingPitcherEra / LEAGUE_AVG_ERA, 0.4, 2.2);
  const homeEraRatio = clamp(home.startingPitcherEra / LEAGUE_AVG_ERA, 0.4, 2.2);
  const homeExpected = (home.runsPerGame + LEAGUE_AVG_RUNS_PER_GAME * awayEraRatio) / 2;
  const awayExpected = (away.runsPerGame + LEAGUE_AVG_RUNS_PER_GAME * homeEraRatio) / 2;
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

export function impliedProbability(decimalOdds) {
  return 1 / decimalOdds;
}

export function edge(estimatedProb, impliedProb) {
  return estimatedProb - impliedProb;
}

export function isSignal(estimatedProb, impliedProb, threshold = 0.05) {
  return edge(estimatedProb, impliedProb) >= threshold;
}

const LEAGUE_AVG_STRIKEOUT_RATE = 0.223;
const AVG_INNINGS_PER_START = 5.5;
const LEAGUE_AVG_HR_RATE = 0.032;
const LEAGUE_AVG_BATTING_AVG = 0.248;

export function expectedPitcherStrikeouts({
  pitcherK9, teamStrikeoutRate, leagueAvgStrikeoutRate = LEAGUE_AVG_STRIKEOUT_RATE, expectedInnings = AVG_INNINGS_PER_START,
  powerContactFactor = 1.0, parkFactor = 1.0, weatherFactor = 1.0,
}) {
  const matchupFactor = clamp(teamStrikeoutRate / leagueAvgStrikeoutRate, 0.5, 1.8);
  const environmentFactor = clamp(powerContactFactor * parkFactor * weatherFactor, 0.75, 1.35);
  return (pitcherK9 / 9) * expectedInnings * matchupFactor * environmentFactor;
}

// Power hitters (high HR rate) tend to strike out more chasing pitches out of the zone;
// high-average/low-power contact hitters tend to put the ball in play more often and strike out less.
// Returns a small multiplier around 1.0 to nudge the strikeout projection based on a batter's profile.
export function computePowerContactFactor({ hrRate, avg, leagueAvgHrRate = LEAGUE_AVG_HR_RATE, leagueAvgAvg = LEAGUE_AVG_BATTING_AVG }) {
  const powerComponent = hrRate / leagueAvgHrRate;
  const contactComponent = avg / leagueAvgAvg;
  const raw = 1 + 0.5 * (powerComponent - 1) - 0.5 * (contactComponent - 1);
  return clamp(raw, 0.85, 1.15);
}

export function computeAveragePowerContactFactor(batterProfiles, leagueAvgHrRate = LEAGUE_AVG_HR_RATE, leagueAvgAvg = LEAGUE_AVG_BATTING_AVG) {
  const valid = (batterProfiles || []).filter(
    p => p && typeof p.hrRate === 'number' && Number.isFinite(p.hrRate) && typeof p.avg === 'number' && Number.isFinite(p.avg)
  );
  if (valid.length === 0) return 1.0;
  const factors = valid.map(p => computePowerContactFactor({ hrRate: p.hrRate, avg: p.avg, leagueAvgHrRate, leagueAvgAvg }));
  return factors.reduce((sum, f) => sum + f, 0) / factors.length;
}

// A pitcher with a bad ERA facing a strong offense is more likely to get pulled early if he gives up runs,
// which shortens his outing and caps his strikeout total. Only reduces innings when both conditions hold.
export function adjustedInningsForEarlyHookRisk({ baseInnings, pitcherEra, opposingOffensiveFactor, leagueAvgEra = LEAGUE_AVG_ERA }) {
  if (!(pitcherEra > leagueAvgEra) || !(opposingOffensiveFactor > 1.0)) return baseInnings;
  const eraRisk = clamp(pitcherEra / leagueAvgEra, 1, 2.5) - 1;
  const offenseRisk = clamp(opposingOffensiveFactor, 1, 1.3) - 1;
  const reduction = clamp(eraRisk * offenseRisk * 3, 0, 0.35);
  return Math.max(baseInnings * (1 - reduction), 2.0);
}

// Best-effort, low-confidence adjustment from whatever weather data is available at analysis time.
// Cold weather slightly favors pitchers (batters less comfortable); hot weather and wind blowing out
// slightly favor hitters. Bounded tightly since this is a secondary factor, not a primary driver.
export function computeWeatherFactorForStrikeouts({ tempF, windMph = 0, windDirection = '' } = {}) {
  if (typeof tempF !== 'number' || !Number.isFinite(tempF)) return 1.0;
  let factor = 1.0;
  if (tempF < 55) factor += 0.03;
  else if (tempF > 85) factor -= 0.02;
  const dir = String(windDirection || '').toLowerCase();
  if (windMph >= 15 && dir.includes('out')) factor += 0.02;
  else if (windMph >= 15 && dir.includes('in')) factor -= 0.02;
  return clamp(factor, 0.93, 1.06);
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

export function formatSignalMessage({ matchup, market, selection, price, impliedProb, estimatedProb, edgeValue, reasoning, emoji = '⚾' }) {
  return `${emoji} ${matchup}\n` +
    `📊 ${market}: ${selection}\n\n` +
    `💰 Cuota: ${price.toFixed(2)} (implícita ${(impliedProb * 100).toFixed(1)}%)\n` +
    `📈 Probabilidad estimada: ${(estimatedProb * 100).toFixed(1)}%\n` +
    `🔥 Edge: ${edgeValue >= 0 ? '+' : ''}${(edgeValue * 100).toFixed(1)}%\n\n` +
    `📝 ${reasoning}`;
}
