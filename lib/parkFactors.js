// lib/parkFactors.js
const NEUTRAL_PARK_FACTOR = 1.00;

// Approximate, manually-curated RUN (offense) park factors. 1.00 = neutral. Static, best-effort,
// based on well-documented long-run park characteristics — not derived from a single season's
// data. Added after a full 2025-season
// backtest (run #33) showed the model had NO park adjustment at all for totals/moneyline runs
// projections, and Colorado Rockies had by far the largest per-team totals bias of any of the 30
// franchises (actual totals ran ~1.8 runs/game higher than projected there) — exactly the
// real-world Coors Field effect this table is meant to correct for.
export const RUN_PARK_FACTORS = {
  'Colorado Rockies': 1.18,
  'Cincinnati Reds': 1.07,
  'Boston Red Sox': 1.04,
  'New York Yankees': 1.04,
  'Philadelphia Phillies': 1.03,
  'Chicago Cubs': 1.02,
  'Arizona Diamondbacks': 1.01,
  'Toronto Blue Jays': 1.01,
  'Milwaukee Brewers': 1.01,
  'Atlanta Braves': 1.00,
  'Washington Nationals': 1.00,
  'Chicago White Sox': 1.00,
  'Minnesota Twins': 0.99,
  'Los Angeles Angels': 0.99,
  'Houston Astros': 0.98,
  'Baltimore Orioles': 0.98,
  'Texas Rangers': 0.97,
  'Detroit Tigers': 0.97,
  'Kansas City Royals': 0.97,
  'Cleveland Guardians': 0.97,
  'Los Angeles Dodgers': 0.97,
  'St. Louis Cardinals': 0.96,
  'Pittsburgh Pirates': 0.96,
  'New York Mets': 0.95,
  'Athletics': 0.95,
  'Tampa Bay Rays': 0.95,
  'Miami Marlins': 0.93,
  'San Diego Padres': 0.93,
  'Seattle Mariners': 0.92,
  'San Francisco Giants': 0.91,
};

export function getRunParkFactor(homeTeamName) {
  return RUN_PARK_FACTORS[homeTeamName] ?? NEUTRAL_PARK_FACTOR;
}
