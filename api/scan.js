// api/scan.js
import { createDbClient, upsertGame, getTodaysSignalId, insertSignal, updateSignal, getConfigValue, gameAlreadyScannedToday, markGameScanned } from '../lib/db.js';
import {
  fetchSchedule, parseScheduleGames, fetchStandings, parseLastTenRecord,
  fetchPitcherGameLog, computeRecentEra, computeSeasonEra, extractPitcherName,
  fetchTeamRoster, parseRoster,
  fetchBatterSeasonStats, extractBattingAvgAndPA,
  fetchPitcherSeasonStats, extractStrikeoutsPer9, extractInningsPerStart, computeRecentStrikeoutsPer9,
  fetchPersonInfo, extractPitchHand,
  extractTeamStrikeoutRate, fetchBatterHittingVsHand, computeAverageStrikeoutRate,
  fetchTeamSeasonHitting, fetchTeamRecentHitting, extractRunsPerGame, extractOpsFromHittingStats,
  fetchTeamRecentSchedule, findMostRecentFinalGamePk, extractStartingLineup, fetchGameBoxscore,
  fetchGameFeed, extractWeather, extractPowerContactProfile,
} from '../lib/mlb.js';
import { fetchMlbOdds, parseOddsEvents, findTeamPrice, findTotalsLine, fetchEventPlayerProps, parsePlayerPropOutcomes } from '../lib/odds.js';
import {
  moneylineEstimate, projectedTotalRuns, overProbability, overProbabilityProp,
  impliedProbability, edge, isSignal, formatSignalMessage,
  expectedPitcherStrikeouts, blendEraEstimates, computeOffensiveFactor, computeLineupOps,
  computeAveragePowerContactFactor, adjustedInningsForEarlyHookRisk, computeWeatherFactorForStrikeouts,
} from '../lib/signals.js';
import { getStrikeoutParkFactor } from '../lib/parkFactors.js';
import { sendTelegramDocument, sendTelegramMessage } from '../lib/telegram.js';

const SEASON = new Date().getFullYear();

async function recordSignal(db, { gamePk, market, selection, price, impliedProb, estimatedProb, edgeValue, reasoning, message, sentMessages, line, subjectId, existingSignalId }) {
  try {
    if (existingSignalId) {
      await updateSignal(db, existingSignalId, { price, impliedProb, estimatedProb, edge: edgeValue, reasoning, line });
    } else {
      await insertSignal(db, { gamePk, market, selection, price, impliedProb, estimatedProb, edge: edgeValue, reasoning, line, subjectId });
    }
    sentMessages.push(message);
  } catch (err) {
    console.error(`Failed to record ${market} signal for game ${gamePk}, ${selection}:`, err);
  }
}

async function fetchRecentLineup(teamId, beforeDate) {
  try {
    const start = new Date(beforeDate);
    start.setUTCDate(start.getUTCDate() - 10);
    const startDate = start.toISOString().slice(0, 10);
    const end = new Date(beforeDate);
    end.setUTCDate(end.getUTCDate() - 1);
    const endDate = end.toISOString().slice(0, 10);
    const scheduleRaw = await fetchTeamRecentSchedule(teamId, startDate, endDate);
    const gamePk = findMostRecentFinalGamePk(scheduleRaw);
    if (!gamePk) return null;
    const boxscoreRaw = await fetchGameBoxscore(gamePk);
    const lineup = extractStartingLineup(boxscoreRaw, teamId);
    return lineup.length > 0 ? lineup : null;
  } catch (err) {
    console.error(`Failed to fetch recent lineup for team ${teamId}:`, err);
    return null;
  }
}

// For each of a lineup's top-5 batters, blends his OPS specifically vs. this pitcher hand with his
// overall season OPS (50/50) — a batter's vs-hand split can be a small, noisy sample within a single
// season, so this keeps the real platoon signal without over-trusting it. Then combines those blended
// per-batter values (leaning on whichever batter(s) actually stand out, not just the lineup average —
// see computeLineupOps) into the single OPS figure used for the offensive factor.
async function computeLineupOpsVsHand(lineup, hand) {
  const batterOpsList = await Promise.all(
    lineup.slice(0, 5).map(async (batter) => {
      try {
        const [vsHandRaw, seasonRaw] = await Promise.all([
          fetchBatterHittingVsHand(batter.personId, hand, SEASON),
          fetchBatterSeasonStats(batter.personId, SEASON),
        ]);
        const vsHandOps = extractOpsFromHittingStats(vsHandRaw);
        const overallOps = extractOpsFromHittingStats(seasonRaw);
        return blendEraEstimates(vsHandOps, overallOps, 0.5);
      } catch (err) {
        return null;
      }
    })
  );
  return computeLineupOps({ batterOpsList });
}

export async function runScan({ force = false } = {}) {
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

  const recentStart = new Date(today);
  recentStart.setUTCDate(recentStart.getUTCDate() - 15);
  const recentStartDate = recentStart.toISOString().slice(0, 10);
  const recentEndDateObj = new Date(today);
  recentEndDateObj.setUTCDate(recentEndDateObj.getUTCDate() - 1);
  const recentEndDate = recentEndDateObj.toISOString().slice(0, 10);

  for (const game of games) {
    await upsertGame(db, { ...game, date: today });

    if (game.status !== 'scheduled') continue;

    if (!force && await gameAlreadyScannedToday(db, game.gamePk)) continue;

    try {
      const oddsEvent = oddsEvents.find(
        e => e.homeTeam === game.homeTeam && e.awayTeam === game.awayTeam
      );
      if (!oddsEvent) continue;

      const homeLast10 = parseLastTenRecord(standingsRaw, game.homeTeamId);
      const awayLast10 = parseLastTenRecord(standingsRaw, game.awayTeamId);

      const homePitcherId = game.homeProbablePitcherId;
      const awayPitcherId = game.awayProbablePitcherId;

      const [
        homeGameLog, awayGameLog,
        homeSeasonHittingRaw, awaySeasonHittingRaw,
        homeRecentHittingRaw, awayRecentHittingRaw,
        homePersonInfoRaw, awayPersonInfoRaw,
        homeRosterRaw, awayRosterRaw, homeLineup, awayLineup,
      ] = await Promise.all([
        homePitcherId ? fetchPitcherGameLog(homePitcherId, SEASON) : Promise.resolve(null),
        awayPitcherId ? fetchPitcherGameLog(awayPitcherId, SEASON) : Promise.resolve(null),
        fetchTeamSeasonHitting(game.homeTeamId, SEASON),
        fetchTeamSeasonHitting(game.awayTeamId, SEASON),
        fetchTeamRecentHitting(game.homeTeamId, SEASON, recentStartDate, recentEndDate),
        fetchTeamRecentHitting(game.awayTeamId, SEASON, recentStartDate, recentEndDate),
        homePitcherId ? fetchPersonInfo(homePitcherId) : Promise.resolve(null),
        awayPitcherId ? fetchPersonInfo(awayPitcherId) : Promise.resolve(null),
        fetchTeamRoster(game.homeTeamId),
        fetchTeamRoster(game.awayTeamId),
        fetchRecentLineup(game.homeTeamId, today),
        fetchRecentLineup(game.awayTeamId, today),
      ]);

      const homeEra = homeGameLog ? computeRecentEra(homeGameLog) : 4.00;
      const awayEra = awayGameLog ? computeRecentEra(awayGameLog) : 4.00;
      const homeSeasonEra = homeGameLog ? computeSeasonEra(homeGameLog) : 4.00;
      const awaySeasonEra = awayGameLog ? computeSeasonEra(awayGameLog) : 4.00;
      const homeBlendedEra = blendEraEstimates(homeEra, homeSeasonEra);
      const awayBlendedEra = blendEraEstimates(awayEra, awaySeasonEra);

      const homeSeasonRunsPerGame = extractRunsPerGame(homeSeasonHittingRaw);
      const awaySeasonRunsPerGame = extractRunsPerGame(awaySeasonHittingRaw);
      const homeRecentRunsPerGame = extractRunsPerGame(homeRecentHittingRaw);
      const awayRecentRunsPerGame = extractRunsPerGame(awayRecentHittingRaw);
      const homeBlendedRunsPerGame = blendEraEstimates(homeRecentRunsPerGame, homeSeasonRunsPerGame);
      const awayBlendedRunsPerGame = blendEraEstimates(awayRecentRunsPerGame, awaySeasonRunsPerGame);

      const homePitcherName = (homeGameLog && extractPitcherName(homeGameLog)) || 'abridor no confirmado';
      const awayPitcherName = (awayGameLog && extractPitcherName(awayGameLog)) || 'abridor no confirmado';

      const homePitchHand = extractPitchHand(homePersonInfoRaw || {});
      const awayPitchHand = extractPitchHand(awayPersonInfoRaw || {});

      const roster = homeLineup || parseRoster(homeRosterRaw);
      const awayRoster = awayLineup || parseRoster(awayRosterRaw);

      const [homeLineupOps, awayLineupOps] = await Promise.all([
        computeLineupOpsVsHand(roster, awayPitchHand),
        computeLineupOpsVsHand(awayRoster, homePitchHand),
      ]);
      const homeOffensiveFactor = computeOffensiveFactor({ lineupOps: homeLineupOps });
      const awayOffensiveFactor = computeOffensiveFactor({ lineupOps: awayLineupOps });

      const homeWinProb = moneylineEstimate({
        home: { last10WinPct: homeLast10, startingPitcherEra: homeBlendedEra, offensiveFactor: homeOffensiveFactor },
        away: { last10WinPct: awayLast10, startingPitcherEra: awayBlendedEra, offensiveFactor: awayOffensiveFactor },
      });
      const awayWinProb = 1 - homeWinProb;

      for (const [team, prob] of [[game.homeTeam, homeWinProb], [game.awayTeam, awayWinProb]]) {
        const price = findTeamPrice(oddsEvent.h2h, team);
        if (!price) continue;
        const implied = impliedProbability(price);
        const edgeValue = edge(prob, implied);
        if (!isSignal(prob, implied, threshold)) continue;
        const existingSignalId = await getTodaysSignalId(db, game.gamePk, 'moneyline', team);
        if (!force && existingSignalId) continue;

        const reasoning = `El modelo compara el pitcheo (ERA de temporada + últimos 5 arranques), la forma reciente en el récord, y qué tan bien está bateando cada lineup titular contra la mano del pitcher rival. Abridor de ${game.homeTeam}: ${homePitcherName}, ERA de temporada ${homeSeasonEra.toFixed(2)} y reciente ${homeEra.toFixed(2)}. Abridor de ${game.awayTeam}: ${awayPitcherName}, ERA de temporada ${awaySeasonEra.toFixed(2)} y reciente ${awayEra.toFixed(2)}. Forma reciente: ${game.homeTeam} lleva ${(homeLast10 * 10).toFixed(0)}-${(10 - homeLast10 * 10).toFixed(0)} en sus últimos 10 juegos, ${game.awayTeam} ${(awayLast10 * 10).toFixed(0)}-${(10 - awayLast10 * 10).toFixed(0)}. El lineup titular de ${game.homeTeam} batea para ${homeLineupOps.toFixed(3)} de OPS contra pitchers de esa mano, el de ${game.awayTeam} para ${awayLineupOps.toFixed(3)}. Con todo esto, el modelo calcula que ${team} tiene más probabilidad de ganar de la que refleja la cuota de la casa.`;
        const message = formatSignalMessage({
          matchup: `${game.awayTeam} @ ${game.homeTeam}`,
          market: 'Moneyline',
          selection: `${team} gana`,
          price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
        });

        await recordSignal(db, { gamePk: game.gamePk, market: 'moneyline', selection: team, price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages, existingSignalId });
      }

      const projectedTotal = projectedTotalRuns({
        home: { runsPerGame: homeBlendedRunsPerGame * homeOffensiveFactor, startingPitcherEra: homeBlendedEra },
        away: { runsPerGame: awayBlendedRunsPerGame * awayOffensiveFactor, startingPitcherEra: awayBlendedEra },
      });
      for (const side of ['Over', 'Under']) {
        const line = findTotalsLine(oddsEvent.totals, side);
        if (!line) continue;
        const prob = side === 'Over' ? overProbability(line.point, projectedTotal) : 1 - overProbability(line.point, projectedTotal);
        const implied = impliedProbability(line.price);
        const edgeValue = edge(prob, implied);
        if (!isSignal(prob, implied, threshold)) continue;
        const existingSignalId = await getTodaysSignalId(db, game.gamePk, 'totals', `${side} ${line.point}`);
        if (!force && existingSignalId) continue;

        const reasoning = `El modelo proyecta que entre ambos equipos anotarán unas ${projectedTotal.toFixed(1)} carreras en este juego. Combina el ERA de cada abridor (temporada ${homeSeasonEra.toFixed(2)}/${awaySeasonEra.toFixed(2)}, reciente ${homeEra.toFixed(2)}/${awayEra.toFixed(2)}), el promedio de carreras de cada ofensiva combinando temporada completa y últimos 15 días (${game.homeTeam}: ${homeBlendedRunsPerGame.toFixed(2)}, ${game.awayTeam}: ${awayBlendedRunsPerGame.toFixed(2)}), y qué tan bien batea el lineup titular de cada equipo contra la mano del pitcher rival (${game.homeTeam}: ${homeLineupOps.toFixed(3)} OPS, ${game.awayTeam}: ${awayLineupOps.toFixed(3)} OPS). La casa de apuestas puso la línea de total de carreras en ${line.point}. Como la proyección del modelo queda ${side === 'Over' ? 'por encima' : 'por debajo'} de esa línea, el modelo ve valor en el ${side === 'Over' ? 'Over (más carreras)' : 'Under (menos carreras)'}.`;
        const message = formatSignalMessage({
          matchup: `${game.awayTeam} @ ${game.homeTeam}`,
          market: 'Totals',
          selection: `${side} ${line.point}`,
          price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
        });

        await recordSignal(db, { gamePk: game.gamePk, market: 'totals', selection: `${side} ${line.point}`, price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages, line: line.point, existingSignalId });
      }

      try {
        const propEventOdds = await fetchEventPlayerProps(process.env.ODDS_API_KEY, oddsEvent.id, 'batter_hits,pitcher_strikeouts');

        let weather = { tempF: null, windMph: 0, windDirection: '', condition: null };
        try {
          const feedRaw = await fetchGameFeed(game.gamePk);
          weather = extractWeather(feedRaw);
        } catch (err) {
          console.error(`Failed to fetch weather for game ${game.gamePk}:`, err);
        }
        const weatherFactor = computeWeatherFactorForStrikeouts(weather);
        const parkFactor = getStrikeoutParkFactor(game.homeTeam);

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
            const existingSignalId = await getTodaysSignalId(db, game.gamePk, 'player_prop', `${player.fullName} hits`);
            if (!force && existingSignalId) continue;

            const reasoning = `${player.fullName} batea para ${avg.toFixed(3)} de promedio esta temporada y suele tener ${paPerGame.toFixed(1)} turnos al bate por juego, lo que da una tasa esperada de ${expectedRate.toFixed(2)} hits por juego. La casa puso la línea en ${overOutcome.point} hits — como la tasa esperada del modelo supera esa línea, ve valor en el Over.`;
            const message = formatSignalMessage({
              matchup: `${game.awayTeam} @ ${game.homeTeam}`,
              market: 'Player Prop',
              selection: `${player.fullName} Over ${overOutcome.point} hits`,
              price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
            });

            await recordSignal(db, { gamePk: game.gamePk, market: 'player_prop', selection: `${player.fullName} hits`, price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages, line: overOutcome.point, subjectId: player.personId, existingSignalId });
          } catch (err) {
            console.error(`Failed to process player prop for ${player.fullName} in game ${game.gamePk}:`, err);
          }
        }

        const pitcherCandidates = [
          {
            pitcherId: homePitcherId, pitcherName: homePitcherName, opposingRoster: awayRoster, gameLog: homeGameLog, pitchHand: homePitchHand,
            ownEra: homeBlendedEra, opposingOffensiveFactor: awayOffensiveFactor, opposingRecentHittingRaw: awayRecentHittingRaw, opposingTeamName: game.awayTeam,
          },
          {
            pitcherId: awayPitcherId, pitcherName: awayPitcherName, opposingRoster: roster, gameLog: awayGameLog, pitchHand: awayPitchHand,
            ownEra: awayBlendedEra, opposingOffensiveFactor: homeOffensiveFactor, opposingRecentHittingRaw: homeRecentHittingRaw, opposingTeamName: game.homeTeam,
          },
        ];

        const HAND_LABEL = { L: 'zurdo', R: 'derecho' };
        const HAND_LABEL_PLURAL = { L: 'zurdos', R: 'derechos' };

        await Promise.all(pitcherCandidates.map(async ({ pitcherId, pitcherName, opposingRoster, gameLog, pitchHand, ownEra, opposingOffensiveFactor, opposingRecentHittingRaw, opposingTeamName }) => {
          if (!pitcherId) return;
          try {
            const outcomes = parsePlayerPropOutcomes(propEventOdds, 'pitcher_strikeouts', pitcherName);
            if (outcomes.length === 0) return;

            const overOutcome = outcomes.find(o => o.name === 'Over');
            if (!overOutcome) return;

            const seasonStatsRaw = await fetchPitcherSeasonStats(pitcherId, SEASON);
            const seasonK9 = extractStrikeoutsPer9(seasonStatsRaw);
            const recentK9 = gameLog ? computeRecentStrikeoutsPer9(gameLog) : seasonK9;
            const pitcherK9 = blendEraEstimates(recentK9, seasonK9);
            const pitcherInningsPerStart = extractInningsPerStart(seasonStatsRaw);
            const batterVsHandRaws = await Promise.all(
              opposingRoster.slice(0, 5).map(async (batter) => {
                try {
                  return await fetchBatterHittingVsHand(batter.personId, pitchHand, SEASON);
                } catch (err) {
                  return null;
                }
              })
            );
            const batterRates = batterVsHandRaws.map(raw => raw ? extractTeamStrikeoutRate(raw) : null);
            const teamStrikeoutRate = computeAverageStrikeoutRate(batterRates);
            const powerContactProfiles = batterVsHandRaws.map(raw => raw ? extractPowerContactProfile(raw) : null);
            const powerContactFactor = computeAveragePowerContactFactor(powerContactProfiles);

            const recentOverallKRate = extractTeamStrikeoutRate(opposingRecentHittingRaw);
            const blendedTeamStrikeoutRate = blendEraEstimates(teamStrikeoutRate, recentOverallKRate, 0.7);

            const adjustedInnings = adjustedInningsForEarlyHookRisk({ baseInnings: pitcherInningsPerStart, pitcherEra: ownEra, opposingOffensiveFactor });

            const expectedK = expectedPitcherStrikeouts({
              pitcherK9, teamStrikeoutRate: blendedTeamStrikeoutRate, expectedInnings: adjustedInnings,
              powerContactFactor, parkFactor, weatherFactor,
            });
            const prob = overProbabilityProp(overOutcome.point, expectedK);
            const implied = impliedProbability(overOutcome.price);
            const edgeValue = edge(prob, implied);
            if (!isSignal(prob, implied, threshold)) return;
            const existingSignalId = await getTodaysSignalId(db, game.gamePk, 'pitcher_strikeouts', `${pitcherName} Ks`);
            if (!force && existingSignalId) return;

            const handLabel = HAND_LABEL[pitchHand] || 'mano no confirmada';
            const handLabelPlural = HAND_LABEL_PLURAL[pitchHand] || 'esa mano';
            const inningsNote = adjustedInnings < pitcherInningsPerStart - 0.05
              ? ` Como ${pitcherName} tiene un ERA de ${ownEra.toFixed(2)} (por encima del promedio) y enfrenta una ofensiva por encima del promedio, el modelo reduce sus innings esperados de ${pitcherInningsPerStart.toFixed(1)} a ${adjustedInnings.toFixed(1)} por el riesgo de que lo saquen temprano si le anotan varias carreras.`
              : '';
            const weatherNote = weather.tempF != null
              ? ` Clima: ${weather.tempF}°F${weather.windMph ? `, viento ${weather.windMph} mph${weather.windDirection ? ` ${weather.windDirection}` : ''}` : ''}.`
              : '';
            const reasoning = `${pitcherName} es ${handLabel} y tiene ${seasonK9.toFixed(2)} ponches por cada 9 innings esta temporada (${recentK9.toFixed(2)} en sus últimos 5 arranques). Se espera que lance unas ${pitcherInningsPerStart.toFixed(1)} innings, su promedio real por arranque esta temporada.${inningsNote} Evaluamos a los bateadores del último lineup usado por ${opposingTeamName} contra pitchers ${handLabelPlural}: en promedio ponchan un ${(teamStrikeoutRate * 100).toFixed(1)}% de sus turnos (liga: ${(0.223 * 100).toFixed(1)}%), y su forma reciente en general (últimos 15 días, no solo contra esta mano) da una tasa de ${(recentOverallKRate * 100).toFixed(1)}%. La mezcla de poder (jonrones) y contacto (bateadores de buen promedio que no suelen conectar jonrón) de ese lineup ajusta la proyección ${powerContactFactor >= 1 ? 'al alza' : 'a la baja'} en un ${(Math.abs(powerContactFactor - 1) * 100).toFixed(1)}%. Factor de parque para ponches en ${game.homeTeam}: ${parkFactor.toFixed(2)}x.${weatherNote} Combinando todo esto, el modelo proyecta unos ${expectedK.toFixed(1)} ponches para ${pitcherName} en este juego. La casa puso la línea en ${overOutcome.point} — como la proyección supera esa línea, el modelo ve valor en el Over.`;
            const message = formatSignalMessage({
              matchup: `${game.awayTeam} @ ${game.homeTeam}`,
              market: 'Pitcher Strikeouts',
              selection: `${pitcherName} Over ${overOutcome.point} Ks`,
              price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
            });

            await recordSignal(db, { gamePk: game.gamePk, market: 'pitcher_strikeouts', selection: `${pitcherName} Ks`, price: overOutcome.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages, line: overOutcome.point, subjectId: pitcherId, existingSignalId });
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

  const scheduledCount = games.filter(g => g.status === 'scheduled').length;
  const { count: scannedCount } = await db
    .from('games')
    .select('game_pk', { count: 'exact', head: true })
    .eq('date', today)
    .not('last_scanned_at', 'is', null);
  const pending = Math.max(0, scheduledCount - (scannedCount || 0));
  if (pending > 0) {
    await sendTelegramMessage(
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.TELEGRAM_CHAT_ID,
      `⏳ Quedan ${pending} de ${scheduledCount} partidos programados sin analizar hoy (posiblemente por un corte de tiempo en una corrida anterior) — se completan automáticamente en la próxima corrida.`
    );
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
