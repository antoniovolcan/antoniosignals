// scripts/backtest.js
// Usage: node scripts/backtest.js 2026-06-01 2026-06-30
// Reconstructs what the moneyline heuristic would have picked for each completed game
// in the date range, using standings/ERA data as they existed then, and compares
// against the actual final score. Prints direction accuracy — no ROI (no historical odds available).
import { fetchSchedule, parseScheduleGames, fetchStandings, parseLastTenRecord, fetchPitcherGameLog, computeRecentEra } from '../lib/mlb.js';
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

async function fetchFinalScore(gamePk) {
  const res = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/linescore`);
  if (!res.ok) return null;
  const data = await res.json();
  return { home: data.teams?.home?.runs, away: data.teams?.away?.runs };
}

async function main() {
  const season = new Date(startDate).getFullYear();
  let correct = 0;
  let total = 0;

  for (const date of dateRange(startDate, endDate)) {
    const games = parseScheduleGames(await fetchSchedule(date));
    const standingsRaw = await fetchStandings(season);

    for (const game of games) {
      if (game.status !== 'final') continue;
      const score = await fetchFinalScore(game.gamePk);
      if (!score || score.home == null || score.away == null) continue;

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
