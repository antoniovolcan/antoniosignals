// lib/battingLedger.js
// A running, point-in-time ledger of real batter-vs-pitcher-hand performance, built incrementally
// from actual play-by-play data (lib/mlb.js's extractPlateAppearances) instead of relying on MLB's
// statSplits/byDateRange endpoints — which give accurate hand-specific splits but only "as of right
// now", or accurate date ranges but with the hand filter silently ignored at the player level (no
// combination of the two exists). Feeding it games in chronological order and reading it before
// feeding it that day's games gives a leak-free "as of this date" batter-vs-hand profile for both
// the live bot and the backtest, from the exact same underlying data.
const TOTAL_BASES = { Single: 1, Double: 2, Triple: 3, 'Home Run': 4 };
const NON_AB_EVENTS = new Set(['Walk', 'Intent Walk', 'Hit By Pitch', 'Sac Fly', 'Sac Bunt', 'Catcher Interference']);
const WALK_EVENTS = new Set(['Walk', 'Intent Walk']);

function emptyBucket() {
  return { pa: 0, ab: 0, hits: 0, hr: 0, totalBases: 0, walks: 0, hbp: 0, strikeouts: 0 };
}

function applyPlateAppearance(bucket, pa) {
  bucket.pa += 1;
  if (pa.event === 'Strikeout') bucket.strikeouts += 1;
  if (NON_AB_EVENTS.has(pa.event)) {
    if (WALK_EVENTS.has(pa.event)) bucket.walks += 1;
    if (pa.event === 'Hit By Pitch') bucket.hbp += 1;
    return;
  }
  bucket.ab += 1;
  const bases = TOTAL_BASES[pa.event];
  if (bases) {
    bucket.hits += 1;
    bucket.totalBases += bases;
    if (pa.event === 'Home Run') bucket.hr += 1;
  }
}

function addBuckets(a, b) {
  return {
    pa: a.pa + b.pa, ab: a.ab + b.ab, hits: a.hits + b.hits, hr: a.hr + b.hr,
    totalBases: a.totalBases + b.totalBases, walks: a.walks + b.walks, hbp: a.hbp + b.hbp,
    strikeouts: a.strikeouts + b.strikeouts,
  };
}

export function computeBucketStats(bucket) {
  if (!bucket || bucket.pa === 0) return null;
  const avg = bucket.ab > 0 ? bucket.hits / bucket.ab : 0;
  const obp = bucket.pa > 0 ? (bucket.hits + bucket.walks + bucket.hbp) / bucket.pa : 0;
  const slg = bucket.ab > 0 ? bucket.totalBases / bucket.ab : 0;
  return {
    pa: bucket.pa, ab: bucket.ab, hits: bucket.hits, hr: bucket.hr,
    avg, obp, slg, ops: obp + slg,
    hrRate: bucket.pa > 0 ? bucket.hr / bucket.pa : 0,
    strikeoutRate: bucket.pa > 0 ? bucket.strikeouts / bucket.pa : 0,
  };
}

export function createLedger() {
  return new Map();
}

// Mutates the ledger in place — call once per game's plate appearances, in chronological order.
export function updateLedgerFromPlateAppearances(ledger, plateAppearances) {
  for (const pa of plateAppearances) {
    if (pa.pitchHand !== 'L' && pa.pitchHand !== 'R') continue;
    if (!ledger.has(pa.batterId)) {
      ledger.set(pa.batterId, { name: pa.batterName, L: emptyBucket(), R: emptyBucket() });
    }
    const entry = ledger.get(pa.batterId);
    applyPlateAppearance(entry[pa.pitchHand], pa);
  }
}

// Returns { name, vsHand: stats|null, overall: stats|null } for a batter, or null if the ledger
// has no data for them yet (e.g. a rookie's first game, or too early in the priming window).
export function getBatterLedgerProfile(ledger, batterId, hand) {
  const entry = ledger.get(batterId);
  if (!entry) return null;
  return {
    name: entry.name,
    vsHand: computeBucketStats(entry[hand]),
    overall: computeBucketStats(addBuckets(entry.L, entry.R)),
  };
}
