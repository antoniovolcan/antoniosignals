// api/scan.js
import { createDbClient, upsertGame, signalAlreadySentToday, insertSignal, getConfigValue } from '../lib/db.js';
import { fetchSchedule, parseScheduleGames, fetchStandings, parseLastTenRecord, fetchPitcherGameLog, computeRecentEra, extractPitcherName, fetchTeamRoster, parseRoster, fetchBatterSeasonStats, extractBattingAvgAndPA, fetchPitcherSeasonStats, extractStrikeoutsPer9, fetchPersonInfo, extractPitchHand, fetchTeamHittingVsHand, extractTeamStrikeoutRate } from '../lib/mlb.js';
import { fetchMlbOdds, parseOddsEvents, findTeamPrice, findTotalsLine, fetchEventPlayerProps, parsePlayerPropOutcomes } from '../lib/odds.js';
import { moneylineEstimate, projectedTotalRuns, overProbability, overProbabilityProp, impliedProbability, edge, isSignal, formatSignalMessage, expectedPitcherStrikeouts } from '../lib/signals.js';
import { sendTelegramMessage } from '../lib/telegram.js';

const SEASON = new Date().getFullYear();

async function recordAndSendSignal(db, { gamePk, market, selection, price, impliedProb, estimatedProb, edgeValue, reasoning, message, sentMessages }) {
  try {
    await insertSignal(db, { gamePk, market, selection, price, impliedProb, estimatedProb, edge: edgeValue, reasoning });
    await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, message);
    sentMessages.push(message);
  } catch (err) {
    console.error(`Failed to record/send ${market} signal for game ${gamePk}, ${selection}:`, err);
  }
}

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
    const [homeGameLog, awayGameLog] = await Promise.all([
      homePitcherId ? fetchPitcherGameLog(homePitcherId, SEASON) : Promise.resolve(null),
      awayPitcherId ? fetchPitcherGameLog(awayPitcherId, SEASON) : Promise.resolve(null),
    ]);
    const homeEra = homeGameLog ? computeRecentEra(homeGameLog) : 4.00;
    const awayEra = awayGameLog ? computeRecentEra(awayGameLog) : 4.00;
    const homePitcherName = (homeGameLog && extractPitcherName(homeGameLog)) || 'abridor no confirmado';
    const awayPitcherName = (awayGameLog && extractPitcherName(awayGameLog)) || 'abridor no confirmado';

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

      const reasoning = `Abridor ${game.homeTeam}: ${homePitcherName} (ERA ${homeEra.toFixed(2)} en últimos 5 arranques). Abridor ${game.awayTeam}: ${awayPitcherName} (ERA ${awayEra.toFixed(2)}). Últimos 10 juegos: ${game.homeTeam} ${(homeLast10 * 10).toFixed(0)}-${(10 - homeLast10 * 10).toFixed(0)}, ${game.awayTeam} ${(awayLast10 * 10).toFixed(0)}-${(10 - awayLast10 * 10).toFixed(0)}.`;
      const message = formatSignalMessage({
        matchup: `${game.awayTeam} @ ${game.homeTeam}`,
        market: 'Moneyline',
        selection: `${team} gana`,
        price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
      });

      await recordAndSendSignal(db, { gamePk: game.gamePk, market: 'moneyline', selection: team, price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages });
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

      const reasoning = `Proyección de carreras: ${projectedTotal.toFixed(1)} vs línea ${line.point}. Abridores: ${game.homeTeam} ${homePitcherName} (ERA ${homeEra.toFixed(2)}), ${game.awayTeam} ${awayPitcherName} (ERA ${awayEra.toFixed(2)}).`;
      const message = formatSignalMessage({
        matchup: `${game.awayTeam} @ ${game.homeTeam}`,
        market: 'Totals',
        selection: `${side} ${line.point}`,
        price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
      });

      await recordAndSendSignal(db, { gamePk: game.gamePk, market: 'totals', selection: `${side} ${line.point}`, price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages });
    }

    try {
      const rosterRaw = await fetchTeamRoster(game.homeTeamId);
      const roster = parseRoster(rosterRaw);
      const propEventOdds = await fetchEventPlayerProps(process.env.ODDS_API_KEY, oddsEvent.id, 'batter_hits,pitcher_strikeouts');

      for (const player of roster.slice(0, 5)) {
        try {
          const outcomes = parsePlayerPropOutcomes(propEventOdds, 'batter_hits', player.fullName);
          if (outcomes.length === 0) continue;

          const battingStats = await fetchBatterSeasonStats(player.personId, SEASON);
          const { avg, paPerGame } = extractBattingAvgAndPA(battingStats);
          const expectedRate = avg * paPerGame;

          const overOutcome = outcomes.find(o => o.name === 'Over');
          if (!overOutcome) continue;

          const prob = overProbabilityProp(overOutcome.point, expectedRate);
          const implied = impliedProbability(overOutcome.price);
          const edgeValue = edge(prob, implied);
          if (!isSignal(prob, implied, threshold)) continue;
          if (await signalAlreadySentToday(db, game.gamePk, 'player_prop', `${player.fullName} hits`)) continue;

          const reasoning = `AVG temporada ${avg.toFixed(3)} en ${paPerGame.toFixed(1)} PA/juego -> tasa esperada ${expectedRate.toFixed(2)} hits/juego vs línea ${overOutcome.point}.`;
          const message = formatSignalMessage({
            matchup: `${game.awayTeam} @ ${game.homeTeam}`,
            market: 'Player Prop',
            selection: `${player.fullName} Over ${overOutcome.point} hits`,
            price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
          });

          await recordAndSendSignal(db, { gamePk: game.gamePk, market: 'player_prop', selection: `${player.fullName} hits`, price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages });
        } catch (err) {
          console.error(`Failed to process player prop for ${player.fullName} in game ${game.gamePk}:`, err);
        }
      }

      const pitcherCandidates = [
        { pitcherId: homePitcherId, pitcherName: homePitcherName, opposingTeamId: game.awayTeamId },
        { pitcherId: awayPitcherId, pitcherName: awayPitcherName, opposingTeamId: game.homeTeamId },
      ];

      for (const { pitcherId, pitcherName, opposingTeamId } of pitcherCandidates) {
        if (!pitcherId) continue;
        try {
          const outcomes = parsePlayerPropOutcomes(propEventOdds, 'pitcher_strikeouts', pitcherName);
          if (outcomes.length === 0) continue;

          const overOutcome = outcomes.find(o => o.name === 'Over');
          if (!overOutcome) continue;

          const [seasonStatsRaw, personInfoRaw] = await Promise.all([
            fetchPitcherSeasonStats(pitcherId, SEASON),
            fetchPersonInfo(pitcherId),
          ]);
          const pitcherK9 = extractStrikeoutsPer9(seasonStatsRaw);
          const pitchHand = extractPitchHand(personInfoRaw);
          const teamHittingRaw = await fetchTeamHittingVsHand(opposingTeamId, pitchHand, SEASON);
          const teamStrikeoutRate = extractTeamStrikeoutRate(teamHittingRaw);

          const expectedK = expectedPitcherStrikeouts({ pitcherK9, teamStrikeoutRate });
          const prob = overProbabilityProp(overOutcome.point, expectedK);
          const implied = impliedProbability(overOutcome.price);
          const edgeValue = edge(prob, implied);
          if (!isSignal(prob, implied, threshold)) continue;
          if (await signalAlreadySentToday(db, game.gamePk, 'pitcher_strikeouts', `${pitcherName} Ks`)) continue;

          const handLabel = pitchHand === 'L' ? 'zurdo' : pitchHand === 'R' ? 'derecho' : 'mano no confirmada';
          const reasoning = `${pitcherName} (${handLabel}) tiene ${pitcherK9.toFixed(2)} K/9 en la temporada. El rival poncha a una tasa de ${(teamStrikeoutRate * 100).toFixed(1)}% contra ${handLabel === 'zurdo' ? 'zurdos' : handLabel === 'derecho' ? 'derechos' : 'esa mano'} -> proyección de ${expectedK.toFixed(1)} ponches vs línea ${overOutcome.point}.`;
          const message = formatSignalMessage({
            matchup: `${game.awayTeam} @ ${game.homeTeam}`,
            market: 'Pitcher Strikeouts',
            selection: `${pitcherName} Over ${overOutcome.point} Ks`,
            price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
          });

          await recordAndSendSignal(db, { gamePk: game.gamePk, market: 'pitcher_strikeouts', selection: `${pitcherName} Ks`, price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages });
        } catch (err) {
          console.error(`Failed to process pitcher strikeout prop for ${pitcherName} in game ${game.gamePk}:`, err);
        }
      }
    } catch (err) {
      console.error(`Failed to fetch roster/props for game ${game.gamePk}:`, err);
    }
  }

  return { scanned: games.length, signalsSent: sentMessages.length };
}

export default async function handler(req, res) {
  if (req.query?.secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const result = await runScan();
    res.status(200).json(result);
  } catch (err) {
    console.error('scan.js error:', err);
    res.status(500).json({ error: err.message });
  }
}
