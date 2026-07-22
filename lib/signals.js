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
