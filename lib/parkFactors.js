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
