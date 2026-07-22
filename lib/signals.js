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
