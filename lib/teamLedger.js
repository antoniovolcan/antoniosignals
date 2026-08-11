// lib/teamLedger.js
// A running, point-in-time ledger of real team performance, built incrementally from actual final
// scores (like lib/battingLedger.js does for batters) instead of only the win/loss record MLB's
// schedule endpoint gives. Feeding it games in chronological order and reading it before feeding it
// that day's games gives a leak-free "as of this date" team profile for both the live bot and the
// backtest, from the exact same underlying data -- and unlocks runs-for/runs-against, which raw
// win-loss record can't give you (two teams can have the same record with very different true
// strength if one's wins/losses were mostly blowouts vs mostly one-run games).
function emptyBucket() {
  return { games: 0, wins: 0, runsFor: 0, runsAgainst: 0 };
}

function applyResult(bucket, { runsFor, runsAgainst, win }) {
  bucket.games += 1;
  if (win) bucket.wins += 1;
  bucket.runsFor += runsFor;
  bucket.runsAgainst += runsAgainst;
}

// Classic Bill James Pythagorean win expectancy (exponent 2). Smooths out the luck in close/blowout
// games that a raw win percentage bakes in -- two teams can have identical records with very
// different underlying run differentials, and the one outscoring opponents by more tends to
// regress UP toward its Pythagorean number going forward, not stay at its lucky/unlucky record.
export function pythagoreanWinPct({ runsFor, runsAgainst }, exponent = 2) {
  if (runsFor === 0 && runsAgainst === 0) return 0.5;
  const rf = Math.pow(runsFor, exponent);
  const ra = Math.pow(runsAgainst, exponent);
  return rf / (rf + ra);
}

export function createTeamLedger() {
  return new Map();
}

// Mutates the ledger in place -- call once per completed game, in chronological order, AFTER that
// day's predictions have already been made (never before), same leak-free discipline as the
// batting ledger.
export function updateTeamLedgerFromGame(ledger, { homeTeamId, awayTeamId, homeScore, awayScore, date }) {
  if (typeof homeScore !== 'number' || typeof awayScore !== 'number') return;
  const homeWin = homeScore > awayScore;
  for (const [teamId, isHome, runsFor, runsAgainst, win] of [
    [homeTeamId, true, homeScore, awayScore, homeWin],
    [awayTeamId, false, awayScore, homeScore, !homeWin],
  ]) {
    if (!ledger.has(teamId)) {
      ledger.set(teamId, { overall: emptyBucket(), home: emptyBucket(), away: emptyBucket(), recent: [] });
    }
    const entry = ledger.get(teamId);
    applyResult(entry.overall, { runsFor, runsAgainst, win });
    applyResult(isHome ? entry.home : entry.away, { runsFor, runsAgainst, win });
    entry.recent.push({ date, runsFor, runsAgainst, win });
  }
}

function bucketFromRecent(recentGames, lastN) {
  const games = lastN ? recentGames.slice(-lastN) : recentGames;
  const bucket = emptyBucket();
  for (const g of games) applyResult(bucket, g);
  return bucket;
}

function computeStreak(recentGames) {
  if (recentGames.length === 0) return 0;
  const last = recentGames[recentGames.length - 1].win;
  let streak = 0;
  for (let i = recentGames.length - 1; i >= 0; i--) {
    if (recentGames[i].win !== last) break;
    streak += 1;
  }
  return last ? streak : -streak;
}

// Returns null if the ledger has no games for this team yet (e.g. too early in the priming
// window). Otherwise a full profile: overall/home/away win% and Pythagorean win%, a recent-N-games
// window (for Pythagorean recent form, complementing the existing win-pct-based recent form), and
// the current win/loss streak (positive = winning streak, negative = losing streak).
export function getTeamLedgerProfile(ledger, teamId, { recentN = 15 } = {}) {
  const entry = ledger.get(teamId);
  if (!entry || entry.overall.games === 0) return null;
  const recentBucket = bucketFromRecent(entry.recent, recentN);
  return {
    games: entry.overall.games,
    winPct: entry.overall.wins / entry.overall.games,
    pythagWinPct: pythagoreanWinPct(entry.overall),
    runsPerGame: entry.overall.runsFor / entry.overall.games,
    runsAllowedPerGame: entry.overall.runsAgainst / entry.overall.games,
    homeWinPct: entry.home.games > 0 ? entry.home.wins / entry.home.games : null,
    awayWinPct: entry.away.games > 0 ? entry.away.wins / entry.away.games : null,
    recentGames: recentBucket.games,
    recentWinPct: recentBucket.games > 0 ? recentBucket.wins / recentBucket.games : null,
    recentPythagWinPct: recentBucket.games > 0 ? pythagoreanWinPct(recentBucket) : null,
    streak: computeStreak(entry.recent),
  };
}
