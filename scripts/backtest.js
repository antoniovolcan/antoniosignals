// scripts/backtest.js
// Usage: node scripts/backtest.js 2026-06-01 2026-06-30
// Reconstructs what the moneyline heuristic would have picked for each completed game
// in the date range, using pitcher ERA as it existed then (computed from each start's
// game log), and compares against the actual final score. Prints direction accuracy —
// no ROI (no historical odds available).
//
// KNOWN LIMITATION: last-10 team win% comes from the live standings endpoint, which
// reflects each team's CURRENT record, not their record as of the historical date being
// backtested. MLB's public StatsAPI has no "standings as of date X" endpoint, so this is
// a form of data leakage (using future information) that inflates/distorts the reported
// accuracy versus what the heuristic would have actually produced live. Treat the printed
// percentage as optimistic/approximate, not a precise historical accuracy measurement.
import { fetchSchedule, parseScheduleGames, fetchStandings, parseLastTenRecord, fetchPitcherGameLog, computeRecentEra, fetchGameLinescore, extractFinalScore } from '../lib/mlb.js';
import { moneylineEstimate } from '../lib/signals.js';

const [, , startDate, endDate] = process.argv;
if (!startDate || !endDate) {
  console.error('Usage: node scripts/backtest.js <start-date YYYY-MM-DD> <end-date YYYY-MM-DD>');
  process.exit(1);
}

function dateRange(start, end) {
  const dates = [];
  let current = new Date(start);
  const last = new Date(end);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function main() {
  const season = new Date(startDate).getFullYear();
  const standingsRaw = await fetchStandings(season);
  let correct = 0;
  let total = 0;

  for (const date of dateRange(startDate, endDate)) {
    const games = parseScheduleGames(await fetchSchedule(date));

    for (const game of games) {
      if (game.status !== 'final') continue;
      const linescoreRaw = await fetchGameLinescore(game.gamePk);
      const score = extractFinalScore(linescoreRaw);
      if (!score) continue;

      const homeLast10 = parseLastTenRecord(standingsRaw, game.homeTeamId);
      const awayLast10 = parseLastTenRecord(standingsRaw, game.awayTeamId);
      const homeEra = game.homeProbablePitcherId
        ? computeRecentEra(await fetchPitcherGameLog(game.homeProbablePitcherId, season))
        : 4.00;
      const awayEra = game.awayProbablePitcherId
        ? computeRecentEra(await fetchPitcherGameLog(game.awayProbablePitcherId, season))
        : 4.00;

      const homeWinProb = moneylineEstimate({
        home: { last10WinPct: homeLast10, startingPitcherEra: homeEra },
        away: { last10WinPct: awayLast10, startingPitcherEra: awayEra },
      });

      const predictedHomeWin = homeWinProb > 0.5;
      const actualHomeWin = score.home > score.away;
      total += 1;
      if (predictedHomeWin === actualHomeWin) correct += 1;
    }
  }

  const accuracy = total === 0 ? 0 : (correct / total) * 100;
  console.log(`Backtest ${startDate} to ${endDate}: ${correct}/${total} correct (${accuracy.toFixed(1)}%)`);
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
