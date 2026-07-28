// lib/parkFactors.js
// Approximate, manually-curated strikeout park factors, keyed by MLB API home team name.
// 1.00 = neutral (league average). Values above 1 mean the park tends to produce more strikeouts
// (e.g. thin/dead air favoring breaking-ball movement, pitcher-friendly dimensions); values below 1
// mean it tends to suppress strikeouts (e.g. thin altitude hurting breaking balls, like Coors Field).
// This is static, low-confidence, best-effort data — not derived from live splits. Revisit periodically.
export const STRIKEOUT_PARK_FACTORS = {
  'Colorado Rockies': 0.93,
  'Arizona Diamondbacks': 0.98,
  'Cincinnati Reds': 1.01,
  'San Francisco Giants': 1.04,
  'San Diego Padres': 1.03,
  'Seattle Mariners': 1.03,
  'Miami Marlins': 1.02,
  'Tampa Bay Rays': 1.02,
  'Detroit Tigers': 1.01,
  'Kansas City Royals': 0.99,
  'Toronto Blue Jays': 1.00,
  'New York Yankees': 0.99,
  'Boston Red Sox': 0.97,
  'Baltimore Orioles': 1.00,
  'Chicago White Sox': 0.99,
  'Cleveland Guardians': 1.00,
  'Minnesota Twins': 1.00,
  'Houston Astros': 0.99,
  'Texas Rangers': 1.00,
  'Los Angeles Angels': 1.00,
  'Athletics': 1.02,
  'New York Mets': 1.02,
  'Philadelphia Phillies': 1.00,
  'Washington Nationals': 1.00,
  'Atlanta Braves': 1.00,
  'Milwaukee Brewers': 1.00,
  'Chicago Cubs': 1.00,
  'St. Louis Cardinals': 1.00,
  'Pittsburgh Pirates': 1.01,
  'Los Angeles Dodgers': 1.02,
};

const NEUTRAL_PARK_FACTOR = 1.00;

export function getStrikeoutParkFactor(homeTeamName) {
  return STRIKEOUT_PARK_FACTORS[homeTeamName] ?? NEUTRAL_PARK_FACTOR;
}

// Approximate, manually-curated RUN (offense) park factors — separate from the strikeout table
// above, since a park can suppress/inflate strikeouts and runs independently (e.g. Coors Field's
// thin air kills breaking-ball movement, hence a below-1.0 strikeout factor, while simultaneously
// inflating runs via more carry on batted balls and a bigger outfield, hence a well-above-1.0 run
// factor here). 1.00 = neutral. Static, best-effort, based on well-documented long-run park
// characteristics — not derived from a single season's data. Added after a full 2025-season
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
