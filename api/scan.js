// api/scan.js
import { createDbClient, upsertGame, signalAlreadySentToday, insertSignal, getConfigValue, gameAlreadyScannedToday, markGameScanned } from '../lib/db.js';
import { fetchSchedule, parseScheduleGames, fetchStandings, parseLastTenRecord, fetchPitcherGameLog, computeRecentEra, computeSeasonEra, extractPitcherName, fetchTeamRoster, parseRoster, fetchBatterSeasonStats, extractBattingAvgAndPA, fetchPitcherSeasonStats, extractStrikeoutsPer9, fetchPersonInfo, extractPitchHand, extractTeamStrikeoutRate, fetchBatterHittingVsHand, computeAverageStrikeoutRate, fetchTeamSeasonHitting, extractRunsPerGame } from '../lib/mlb.js';
import { fetchMlbOdds, parseOddsEvents, findTeamPrice, findTotalsLine, fetchEventPlayerProps, parsePlayerPropOutcomes } from '../lib/odds.js';
import { moneylineEstimate, projectedTotalRuns, overProbability, overProbabilityProp, impliedProbability, edge, isSignal, formatSignalMessage, expectedPitcherStrikeouts, blendEraEstimates } from '../lib/signals.js';
import { sendTelegramDocument } from '../lib/telegram.js';

const SEASON = new Date().getFullYear();

async function recordSignal(db, { gamePk, market, selection, price, impliedProb, estimatedProb, edgeValue, reasoning, message, sentMessages, line, subjectId }) {
  try {
    await insertSignal(db, { gamePk, market, selection, price, impliedProb, estimatedProb, edge: edgeValue, reasoning, line, subjectId });
    sentMessages.push(message);
  } catch (err) {
    console.error(`Failed to record ${market} signal for game ${gamePk}, ${selection}:`, err);
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

    if (await gameAlreadyScannedToday(db, game.gamePk)) continue;

    try {
    const oddsEvent = oddsEvents.find(
      e => e.homeTeam === game.homeTeam && e.awayTeam === game.awayTeam
    );
    if (!oddsEvent) continue;

    const homeLast10 = parseLastTenRecord(standingsRaw, game.homeTeamId);
    const awayLast10 = parseLastTenRecord(standingsRaw, game.awayTeamId);

    const homePitcherId = game.homeProbablePitcherId;
    const awayPitcherId = game.awayProbablePitcherId;
    const [homeGameLog, awayGameLog, homeHittingRaw, awayHittingRaw] = await Promise.all([
      homePitcherId ? fetchPitcherGameLog(homePitcherId, SEASON) : Promise.resolve(null),
      awayPitcherId ? fetchPitcherGameLog(awayPitcherId, SEASON) : Promise.resolve(null),
      fetchTeamSeasonHitting(game.homeTeamId, SEASON),
      fetchTeamSeasonHitting(game.awayTeamId, SEASON),
    ]);
    const homeEra = homeGameLog ? computeRecentEra(homeGameLog) : 4.00;
    const awayEra = awayGameLog ? computeRecentEra(awayGameLog) : 4.00;
    const homeSeasonEra = homeGameLog ? computeSeasonEra(homeGameLog) : 4.00;
    const awaySeasonEra = awayGameLog ? computeSeasonEra(awayGameLog) : 4.00;
    const homeBlendedEra = blendEraEstimates(homeEra, homeSeasonEra);
    const awayBlendedEra = blendEraEstimates(awayEra, awaySeasonEra);
    const homeRunsPerGame = extractRunsPerGame(homeHittingRaw);
    const awayRunsPerGame = extractRunsPerGame(awayHittingRaw);
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

      const reasoning = `El modelo compara el nivel de pitcheo reciente y el momento de cada equipo. Abridor de ${game.homeTeam}: ${homePitcherName}, con ERA de ${homeEra.toFixed(2)} en sus últimos 5 arranques (mientras más bajo, mejor viene lanzando). Abridor de ${game.awayTeam}: ${awayPitcherName}, ERA de ${awayEra.toFixed(2)}. Forma reciente: ${game.homeTeam} lleva ${(homeLast10 * 10).toFixed(0)}-${(10 - homeLast10 * 10).toFixed(0)} en sus últimos 10 juegos, ${game.awayTeam} ${(awayLast10 * 10).toFixed(0)}-${(10 - awayLast10 * 10).toFixed(0)}. Con estos datos, el modelo calcula que ${team} tiene más probabilidad de ganar de la que refleja la cuota de la casa.`;
      const message = formatSignalMessage({
        matchup: `${game.awayTeam} @ ${game.homeTeam}`,
        market: 'Moneyline',
        selection: `${team} gana`,
        price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
      });

      await recordSignal(db, { gamePk: game.gamePk, market: 'moneyline', selection: team, price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages });
    }

    const projectedTotal = projectedTotalRuns({
      home: { runsPerGame: homeRunsPerGame, startingPitcherEra: homeBlendedEra },
      away: { runsPerGame: awayRunsPerGame, startingPitcherEra: awayBlendedEra },
    });
    for (const side of ['Over', 'Under']) {
      const line = findTotalsLine(oddsEvent.totals, side);
      if (!line) continue;
      const prob = side === 'Over' ? overProbability(line.point, projectedTotal) : 1 - overProbability(line.point, projectedTotal);
      const implied = impliedProbability(line.price);
      const edgeValue = edge(prob, implied);
      if (!isSignal(prob, implied, threshold)) continue;
      if (await signalAlreadySentToday(db, game.gamePk, 'totals', side)) continue;

      const reasoning = `El modelo proyecta que entre ambos equipos anotarán unas ${projectedTotal.toFixed(1)} carreras en este juego. Esto combina el ERA de cada abridor esta temporada con su ERA en sus últimos 5 arranques (${game.homeTeam}: ${homePitcherName}, ERA de temporada ${homeSeasonEra.toFixed(2)} y reciente ${homeEra.toFixed(2)}; ${game.awayTeam}: ${awayPitcherName}, ERA de temporada ${awaySeasonEra.toFixed(2)} y reciente ${awayEra.toFixed(2)}) junto con el promedio real de carreras anotadas por partido de cada ofensiva esta temporada (${game.homeTeam}: ${homeRunsPerGame.toFixed(2)}, ${game.awayTeam}: ${awayRunsPerGame.toFixed(2)}). La casa de apuestas puso la línea de total de carreras en ${line.point}. Como la proyección del modelo queda ${side === 'Over' ? 'por encima' : 'por debajo'} de esa línea, el modelo ve valor en el ${side === 'Over' ? 'Over (más carreras)' : 'Under (menos carreras)'}.`;
      const message = formatSignalMessage({
        matchup: `${game.awayTeam} @ ${game.homeTeam}`,
        market: 'Totals',
        selection: `${side} ${line.point}`,
        price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
      });

      await recordSignal(db, { gamePk: game.gamePk, market: 'totals', selection: `${side} ${line.point}`, price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages, line: line.point });
    }

    try {
      const [rosterRaw, awayRosterRaw] = await Promise.all([
        fetchTeamRoster(game.homeTeamId),
        fetchTeamRoster(game.awayTeamId),
      ]);
      const roster = parseRoster(rosterRaw);
      const awayRoster = parseRoster(awayRosterRaw);
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

          const reasoning = `${player.fullName} batea para ${avg.toFixed(3)} de promedio esta temporada y suele tener ${paPerGame.toFixed(1)} turnos al bate por juego, lo que da una tasa esperada de ${expectedRate.toFixed(2)} hits por juego. La casa puso la línea en ${overOutcome.point} hits — como la tasa esperada del modelo supera esa línea, ve valor en el Over.`;
          const message = formatSignalMessage({
            matchup: `${game.awayTeam} @ ${game.homeTeam}`,
            market: 'Player Prop',
            selection: `${player.fullName} Over ${overOutcome.point} hits`,
            price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
          });

          await recordSignal(db, { gamePk: game.gamePk, market: 'player_prop', selection: `${player.fullName} hits`, price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages, line: overOutcome.point, subjectId: player.personId });
        } catch (err) {
          console.error(`Failed to process player prop for ${player.fullName} in game ${game.gamePk}:`, err);
        }
      }

      const pitcherCandidates = [
        { pitcherId: homePitcherId, pitcherName: homePitcherName, opposingRoster: awayRoster },
        { pitcherId: awayPitcherId, pitcherName: awayPitcherName, opposingRoster: roster },
      ];

      const HAND_LABEL = { L: 'zurdo', R: 'derecho' };
      const HAND_LABEL_PLURAL = { L: 'zurdos', R: 'derechos' };

      await Promise.all(pitcherCandidates.map(async ({ pitcherId, pitcherName, opposingRoster }) => {
        if (!pitcherId) return;
        try {
          const outcomes = parsePlayerPropOutcomes(propEventOdds, 'pitcher_strikeouts', pitcherName);
          if (outcomes.length === 0) return;

          const overOutcome = outcomes.find(o => o.name === 'Over');
          if (!overOutcome) return;

          const [seasonStatsRaw, personInfoRaw] = await Promise.all([
            fetchPitcherSeasonStats(pitcherId, SEASON),
            fetchPersonInfo(pitcherId),
          ]);
          const pitcherK9 = extractStrikeoutsPer9(seasonStatsRaw);
          const pitchHand = extractPitchHand(personInfoRaw);
          const batterRates = await Promise.all(
            opposingRoster.slice(0, 5).map(async (batter) => {
              try {
                const raw = await fetchBatterHittingVsHand(batter.personId, pitchHand, SEASON);
                return extractTeamStrikeoutRate(raw);
              } catch (err) {
                return null;
              }
            })
          );
          const teamStrikeoutRate = computeAverageStrikeoutRate(batterRates);

          const expectedK = expectedPitcherStrikeouts({ pitcherK9, teamStrikeoutRate });
          const prob = overProbabilityProp(overOutcome.point, expectedK);
          const implied = impliedProbability(overOutcome.price);
          const edgeValue = edge(prob, implied);
          if (!isSignal(prob, implied, threshold)) return;
          if (await signalAlreadySentToday(db, game.gamePk, 'pitcher_strikeouts', `${pitcherName} Ks`)) return;

          const handLabel = HAND_LABEL[pitchHand] || 'mano no confirmada';
          const handLabelPlural = HAND_LABEL_PLURAL[pitchHand] || 'esa mano';
          const reasoning = `${pitcherName} es ${handLabel} y tiene ${pitcherK9.toFixed(2)} ponches por cada 9 innings esta temporada. Evaluamos a los bateadores del roster rival contra pitchers ${handLabelPlural} y en promedio ponchan un ${(teamStrikeoutRate * 100).toFixed(1)}% de sus turnos (el promedio de liga es ${(0.223 * 100).toFixed(1)}%). Combinando ambos factores, el modelo proyecta unos ${expectedK.toFixed(1)} ponches para ${pitcherName} en este juego. La casa puso la línea en ${overOutcome.point} — como la proyección supera esa línea, el modelo ve valor en el Over.`;
          const message = formatSignalMessage({
            matchup: `${game.awayTeam} @ ${game.homeTeam}`,
            market: 'Pitcher Strikeouts',
            selection: `${pitcherName} Over ${overOutcome.point} Ks`,
            price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
          });

          await recordSignal(db, { gamePk: game.gamePk, market: 'pitcher_strikeouts', selection: `${pitcherName} Ks`, price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages, line: overOutcome.point, subjectId: pitcherId });
        } catch (err) {
          console.error(`Failed to process pitcher strikeout prop for ${pitcherName} in game ${game.gamePk}:`, err);
        }
      }));
    } catch (err) {
      console.error(`Failed to fetch roster/props for game ${game.gamePk}:`, err);
    }

    await markGameScanned(db, game.gamePk);
    } catch (err) {
      console.error(`Failed to process game ${game.gamePk} (${game.awayTeam} @ ${game.homeTeam}):`, err);
    }
  }

  if (sentMessages.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `senales_${timestamp}.txt`;
    const content = sentMessages.join('\n\n' + '='.repeat(40) + '\n\n');
    await sendTelegramDocument(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, filename, content, `📄 ${sentMessages.length} señal${sentMessages.length === 1 ? '' : 'es'} nueva${sentMessages.length === 1 ? '' : 's'}`);
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
