// api/scan.js
import { createDbClient, upsertGame, signalAlreadySentToday, insertSignal, getConfigValue } from '../lib/db.js';
import { fetchSchedule, parseScheduleGames, fetchStandings, parseLastTenRecord, fetchPitcherGameLog, computeRecentEra } from '../lib/mlb.js';
import { fetchMlbOdds, parseOddsEvents, findTeamPrice, findTotalsLine } from '../lib/odds.js';
import { moneylineEstimate, projectedTotalRuns, overProbability, impliedProbability, edge, isSignal, formatSignalMessage } from '../lib/signals.js';
import { sendTelegramMessage } from '../lib/telegram.js';

const SEASON = new Date().getFullYear();

export async function runScan() {
  const db = createDbClient();
  const today = new Date().toISOString().slice(0, 10);
  const threshold = Number(await getConfigValue(db, 'edge_threshold', '0.05'));

  const [scheduleRaw, standingsRaw, oddsRaw] = await Promise.all([
    fetchSchedule(today),
    fetchStandings(SEASON),
    fetchMlbOdds(process.env.ODDS_API_KEY),
  ]);

  const games = parseScheduleGames(scheduleRaw);
  const oddsEvents = parseOddsEvents(oddsRaw);
  const sentMessages = [];

  for (const game of games) {
    await upsertGame(db, { ...game, date: today });

    if (game.status !== 'scheduled') continue;

    const oddsEvent = oddsEvents.find(
      e => e.homeTeam === game.homeTeam && e.awayTeam === game.awayTeam
    );
    if (!oddsEvent) continue;

    const homeLast10 = parseLastTenRecord(standingsRaw, game.homeTeamId);
    const awayLast10 = parseLastTenRecord(standingsRaw, game.awayTeamId);

    const homePitcherId = game.homeProbablePitcherId;
    const awayPitcherId = game.awayProbablePitcherId;
    const [homeEra, awayEra] = await Promise.all([
      homePitcherId ? computeRecentEra(await fetchPitcherGameLog(homePitcherId, SEASON)) : Promise.resolve(4.00),
      awayPitcherId ? computeRecentEra(await fetchPitcherGameLog(awayPitcherId, SEASON)) : Promise.resolve(4.00),
    ]);

    const homeWinProb = moneylineEstimate({
      home: { last10WinPct: homeLast10, startingPitcherEra: homeEra },
      away: { last10WinPct: awayLast10, startingPitcherEra: awayEra },
    });
    const awayWinProb = 1 - homeWinProb;

    for (const [team, prob] of [[game.homeTeam, homeWinProb], [game.awayTeam, awayWinProb]]) {
      const price = findTeamPrice(oddsEvent.h2h, team);
      if (!price) continue;
      const implied = impliedProbability(price);
      const edgeValue = edge(prob, implied);
      if (!isSignal(prob, implied, threshold)) continue;
      if (await signalAlreadySentToday(db, game.gamePk, 'moneyline', team)) continue;

      const reasoning = `ERA reciente: ${game.homeTeam} ${homeEra.toFixed(2)} / ${game.awayTeam} ${awayEra.toFixed(2)}. Últimos 10: ${game.homeTeam} ${(homeLast10 * 10).toFixed(0)}-${(10 - homeLast10 * 10).toFixed(0)}, ${game.awayTeam} ${(awayLast10 * 10).toFixed(0)}-${(10 - awayLast10 * 10).toFixed(0)}.`;
      const message = formatSignalMessage({
        matchup: `${game.awayTeam} @ ${game.homeTeam}`,
        market: 'Moneyline',
        selection: `${team} gana`,
        price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
      });

      try {
        await insertSignal(db, { gamePk: game.gamePk, market: 'moneyline', selection: team, price, impliedProb: implied, estimatedProb: prob, edge: edgeValue, reasoning });
        await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, message);
        sentMessages.push(message);
      } catch (err) {
        console.error(`Failed to record/send moneyline signal for game ${game.gamePk}, team ${team}:`, err);
      }
    }

    const projectedTotal = projectedTotalRuns({
      home: { runsPerGame: 4.5, startingPitcherEra: homeEra },
      away: { runsPerGame: 4.5, startingPitcherEra: awayEra },
    });
    for (const side of ['Over', 'Under']) {
      const line = findTotalsLine(oddsEvent.totals, side);
      if (!line) continue;
      const prob = side === 'Over' ? overProbability(line.point, projectedTotal) : 1 - overProbability(line.point, projectedTotal);
      const implied = impliedProbability(line.price);
      const edgeValue = edge(prob, implied);
      if (!isSignal(prob, implied, threshold)) continue;
      if (await signalAlreadySentToday(db, game.gamePk, 'totals', side)) continue;

      const reasoning = `Proyección de carreras: ${projectedTotal.toFixed(1)} vs línea ${line.point}. ERA recientes: ${homeEra.toFixed(2)} / ${awayEra.toFixed(2)}.`;
      const message = formatSignalMessage({
        matchup: `${game.awayTeam} @ ${game.homeTeam}`,
        market: 'Totals',
        selection: `${side} ${line.point}`,
        price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
      });

      try {
        await insertSignal(db, { gamePk: game.gamePk, market: 'totals', selection: `${side} ${line.point}`, price: line.price, impliedProb: implied, estimatedProb: prob, edge: edgeValue, reasoning });
        await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, message);
        sentMessages.push(message);
      } catch (err) {
        console.error(`Failed to record/send totals signal for game ${game.gamePk}, selection ${side} ${line.point}:`, err);
      }
    }
  }

  return { scanned: games.length, signalsSent: sentMessages.length };
}

export default async function handler(req, res) {
  try {
    const result = await runScan();
    res.status(200).json(result);
  } catch (err) {
    console.error('scan.js error:', err);
    res.status(500).json({ error: err.message });
  }
}
