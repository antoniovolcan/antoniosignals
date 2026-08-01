// api/scan.js
import { createDbClient, upsertGame, getTodaysSignalId, insertSignal, updateSignal, getConfigValue, gameAlreadyScannedToday, markGameScanned, getSimPrediction } from '../lib/db.js';
import {
  fetchSchedule, parseScheduleGames,
  fetchPitcherGameLog, computeRecentEra, computeSeasonEra, extractPitcherName,
  fetchPitcherYearByYearStats, computeCareerEraBeforeSeason,
  fetchTeamRoster, parseRoster,
  fetchBatterSeasonStats,
  fetchPersonInfo, extractPitchHand,
  fetchBatterHittingVsHand,
  fetchTeamSeasonHitting, fetchTeamRecentHitting, extractRunsPerGame, extractOpsFromHittingStats,
  fetchTeamRecentSchedule, computeWinPctFromSchedule, findMostRecentFinalGamePk, extractStartingLineup, fetchGameBoxscore,
  mlbDateToday, addDaysToDateString,
} from '../lib/mlb.js';
import { fetchMlbOdds, parseOddsEvents, findTeamPrice, findTotalsLine, fetchEventPlayerProps, extractMarket } from '../lib/odds.js';
import {
  moneylineEstimate, projectedTotalRuns, projectedFirstFiveInningsRuns, overProbability,
  impliedProbability, edge, isSignal, isConfidentEnough, formatSignalMessage,
  blendEraEstimates, computeOffensiveFactor, computeLineupOps, LEAGUE_AVG_TOP_WEIGHTED_OPS,
  CAREER_ERA_WEIGHT, formatCareerEraNote, formatCareerEraPairNote,
  TEAM_RECORD_RECENT_WEIGHT, formatSimComparisonNote,
} from '../lib/signals.js';
import { getRunParkFactor } from '../lib/parkFactors.js';
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

// Blends a team's last-15-games record with its season-to-date record (see TEAM_RECORD_RECENT_WEIGHT
// in signals.js for why season-to-date is weighted more heavily) — one schedule fetch (from the
// season opener through yesterday) serves both windows, since computeWinPctFromSchedule can slice
// to the most recent N games or count everything in the response.
async function computeTeamRecordWinPct(teamId, beforeDate) {
  const yesterday = new Date(beforeDate);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const endDate = yesterday.toISOString().slice(0, 10);
  const scheduleRaw = await fetchTeamRecentSchedule(teamId, `${SEASON}-01-01`, endDate);
  const seasonWinPct = computeWinPctFromSchedule(scheduleRaw, teamId);
  const recentWinPct = computeWinPctFromSchedule(scheduleRaw, teamId, { lastN: 15 });
  return { recordWinPct: blendEraEstimates(recentWinPct, seasonWinPct, TEAM_RECORD_RECENT_WEIGHT), seasonWinPct, recentWinPct };
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

const OFFENSIVE_FACTOR_LINEUP_SIZE = 9; // full projected batting order, not just the top 5

// For each of a lineup's top batters, blends his OPS specifically vs. this pitcher hand with his
// overall season OPS (50/50) — a batter's vs-hand split can be a small, noisy sample within a single
// season, so this keeps the real platoon signal without over-trusting it. Then combines those blended
// per-batter values (leaning on whichever batter(s) actually stand out, not just the lineup average —
// see computeLineupOps) into the single OPS figure used for the offensive factor.
async function computeLineupOpsVsHand(lineup, hand) {
  const batterOpsList = await Promise.all(
    lineup.slice(0, OFFENSIVE_FACTOR_LINEUP_SIZE).map(async (batter) => {
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
  return computeLineupOps({ batterOpsList, leagueAvgOps: LEAGUE_AVG_TOP_WEIGHTED_OPS });
}

export async function runScan({ force = false } = {}) {
  const db = createDbClient();
  const today = mlbDateToday();
  const threshold = Number(await getConfigValue(db, 'edge_threshold', '0.05'));

  const [scheduleRaw, oddsRaw] = await Promise.all([
    fetchSchedule(today),
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

      const [homeRecord, awayRecord] = await Promise.all([
        computeTeamRecordWinPct(game.homeTeamId, today),
        computeTeamRecordWinPct(game.awayTeamId, today),
      ]);

      const homePitcherId = game.homeProbablePitcherId;
      const awayPitcherId = game.awayProbablePitcherId;

      const [
        homeGameLog, awayGameLog,
        homeYearByYearRaw, awayYearByYearRaw,
        homeSeasonHittingRaw, awaySeasonHittingRaw,
        homeRecentHittingRaw, awayRecentHittingRaw,
        homePersonInfoRaw, awayPersonInfoRaw,
        homeRosterRaw, awayRosterRaw, homeLineup, awayLineup,
      ] = await Promise.all([
        homePitcherId ? fetchPitcherGameLog(homePitcherId, SEASON) : Promise.resolve(null),
        awayPitcherId ? fetchPitcherGameLog(awayPitcherId, SEASON) : Promise.resolve(null),
        homePitcherId ? fetchPitcherYearByYearStats(homePitcherId) : Promise.resolve(null),
        awayPitcherId ? fetchPitcherYearByYearStats(awayPitcherId) : Promise.resolve(null),
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
      const homeCareerEra = homeYearByYearRaw ? computeCareerEraBeforeSeason(homeYearByYearRaw, SEASON) : null;
      const awayCareerEra = awayYearByYearRaw ? computeCareerEraBeforeSeason(awayYearByYearRaw, SEASON) : null;
      const homeRecentSeasonEra = blendEraEstimates(homeEra, homeSeasonEra);
      const awayRecentSeasonEra = blendEraEstimates(awayEra, awaySeasonEra);
      const homeBlendedEra = homeCareerEra == null ? homeRecentSeasonEra : blendEraEstimates(homeRecentSeasonEra, homeCareerEra, CAREER_ERA_WEIGHT);
      const awayBlendedEra = awayCareerEra == null ? awayRecentSeasonEra : blendEraEstimates(awayRecentSeasonEra, awayCareerEra, CAREER_ERA_WEIGHT);

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
      const homeOffensiveFactor = computeOffensiveFactor({ lineupOps: homeLineupOps, leagueAvgOps: LEAGUE_AVG_TOP_WEIGHTED_OPS });
      const awayOffensiveFactor = computeOffensiveFactor({ lineupOps: awayLineupOps, leagueAvgOps: LEAGUE_AVG_TOP_WEIGHTED_OPS });

      const homeWinProb = moneylineEstimate({
        home: { recordWinPct: homeRecord.recordWinPct, startingPitcherEra: homeBlendedEra, offensiveFactor: homeOffensiveFactor },
        away: { recordWinPct: awayRecord.recordWinPct, startingPitcherEra: awayBlendedEra, offensiveFactor: awayOffensiveFactor },
      });
      const awayWinProb = 1 - homeWinProb;

      const simPrediction = await getSimPrediction(db, today, game.homeTeam, game.awayTeam);

      for (const [team, prob] of [[game.homeTeam, homeWinProb], [game.awayTeam, awayWinProb]]) {
        const price = findTeamPrice(oddsEvent.h2h, team);
        if (!price) continue;
        const implied = impliedProbability(price);
        const edgeValue = edge(prob, implied);
        if (!isSignal(prob, implied, threshold)) continue;
        if (!isConfidentEnough(prob)) continue;
        const existingSignalId = await getTodaysSignalId(db, game.gamePk, 'moneyline', team);
        if (!force && existingSignalId) continue;

        const reasoning = `El modelo compara el pitcheo (ERA de temporada + últimos 5 arranques + carrera), el récord de cada equipo (últimos 15 partidos y temporada completa), y qué tan bien está bateando cada lineup titular contra la mano del pitcher rival. Abridor de ${game.homeTeam}: ${homePitcherName}, ERA de temporada ${homeSeasonEra.toFixed(2)}${formatCareerEraNote(homeCareerEra)} y reciente ${homeEra.toFixed(2)}. Abridor de ${game.awayTeam}: ${awayPitcherName}, ERA de temporada ${awaySeasonEra.toFixed(2)}${formatCareerEraNote(awayCareerEra)} y reciente ${awayEra.toFixed(2)}. Récord: ${game.homeTeam} tiene ${(homeRecord.seasonWinPct * 100).toFixed(1)}% de victorias en la temporada (${(homeRecord.recentWinPct * 100).toFixed(1)}% en sus últimos 15), ${game.awayTeam} ${(awayRecord.seasonWinPct * 100).toFixed(1)}% en la temporada (${(awayRecord.recentWinPct * 100).toFixed(1)}% en sus últimos 15). El lineup titular de ${game.homeTeam} batea para ${homeLineupOps.toFixed(3)} de OPS contra pitchers de esa mano, el de ${game.awayTeam} para ${awayLineupOps.toFixed(3)}. Con todo esto, el modelo calcula que ${team} tiene más probabilidad de ganar de la que refleja la cuota de la casa.${formatSimComparisonNote(simPrediction, team)}`;
        const message = formatSignalMessage({
          matchup: `${game.awayTeam} @ ${game.homeTeam}`,
          market: 'Moneyline',
          selection: `${team} gana`,
          price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
        });

        await recordSignal(db, { gamePk: game.gamePk, market: 'moneyline', selection: team, price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages, existingSignalId });
      }

      const runParkFactor = getRunParkFactor(game.homeTeam);
      const projectedTotal = projectedTotalRuns({
        home: { runsPerGame: homeBlendedRunsPerGame * homeOffensiveFactor, startingPitcherEra: homeBlendedEra },
        away: { runsPerGame: awayBlendedRunsPerGame * awayOffensiveFactor, startingPitcherEra: awayBlendedEra },
        parkFactor: runParkFactor,
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

        const reasoning = `El modelo proyecta que entre ambos equipos anotarán unas ${projectedTotal.toFixed(1)} carreras en este juego. Combina el ERA de cada abridor (temporada ${homeSeasonEra.toFixed(2)}/${awaySeasonEra.toFixed(2)}, reciente ${homeEra.toFixed(2)}/${awayEra.toFixed(2)}), el promedio de carreras de cada ofensiva combinando temporada completa y últimos 15 días (${game.homeTeam}: ${homeBlendedRunsPerGame.toFixed(2)}, ${game.awayTeam}: ${awayBlendedRunsPerGame.toFixed(2)}), y qué tan bien batea el lineup titular de cada equipo contra la mano del pitcher rival (${game.homeTeam}: ${homeLineupOps.toFixed(3)} OPS, ${game.awayTeam}: ${awayLineupOps.toFixed(3)} OPS).${formatCareerEraPairNote({ homeTeam: game.homeTeam, awayTeam: game.awayTeam, homeCareerEra, awayCareerEra })} Factor de parque para carreras en ${game.homeTeam}: ${runParkFactor.toFixed(2)}x. La casa de apuestas puso la línea de total de carreras en ${line.point}. Como la proyección del modelo queda ${side === 'Over' ? 'por encima' : 'por debajo'} de esa línea, el modelo ve valor en el ${side === 'Over' ? 'Over (más carreras)' : 'Under (menos carreras)'}.`;
        const message = formatSignalMessage({
          matchup: `${game.awayTeam} @ ${game.homeTeam}`,
          market: 'Totals',
          selection: `${side} ${line.point}`,
          price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
        });

        await recordSignal(db, { gamePk: game.gamePk, market: 'totals', selection: `${side} ${line.point}`, price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages, line: line.point, existingSignalId });
      }

      try {
        const propEventOdds = await fetchEventPlayerProps(process.env.ODDS_API_KEY, oddsEvent.id, 'totals_1st_5_innings');
        const f5Market = extractMarket(propEventOdds, 'totals_1st_5_innings');
        if (f5Market) {
          const projectedF5Total = projectedFirstFiveInningsRuns({
            home: { runsPerGame: homeBlendedRunsPerGame * homeOffensiveFactor, startingPitcherEra: homeBlendedEra },
            away: { runsPerGame: awayBlendedRunsPerGame * awayOffensiveFactor, startingPitcherEra: awayBlendedEra },
            parkFactor: runParkFactor,
          });
          for (const side of ['Over', 'Under']) {
            const line = findTotalsLine(f5Market, side);
            if (!line) continue;
            const prob = side === 'Over' ? overProbability(line.point, projectedF5Total) : 1 - overProbability(line.point, projectedF5Total);
            const implied = impliedProbability(line.price);
            const edgeValue = edge(prob, implied);
            if (!isSignal(prob, implied, threshold)) continue;
            const existingSignalId = await getTodaysSignalId(db, game.gamePk, 'totals_f5', `${side} ${line.point}`);
            if (!force && existingSignalId) continue;

            const reasoning = `El modelo proyecta ${projectedF5Total.toFixed(1)} carreras combinadas en las primeras 5 entradas (antes de que entre el bullpen de cualquiera de los dos equipos), usando el ERA de cada abridor (temporada ${homeSeasonEra.toFixed(2)}/${awaySeasonEra.toFixed(2)}, reciente ${homeEra.toFixed(2)}/${awayEra.toFixed(2)}) y el factor ofensivo de cada lineup contra la mano rival (${game.homeTeam}: ${homeLineupOps.toFixed(3)} OPS, ${game.awayTeam}: ${awayLineupOps.toFixed(3)} OPS).${formatCareerEraPairNote({ homeTeam: game.homeTeam, awayTeam: game.awayTeam, homeCareerEra, awayCareerEra })} Factor de parque para carreras en ${game.homeTeam}: ${runParkFactor.toFixed(2)}x. La casa puso la línea de primeras 5 entradas en ${line.point}. Como la proyección queda ${side === 'Over' ? 'por encima' : 'por debajo'} de esa línea, el modelo ve valor en el ${side === 'Over' ? 'Over' : 'Under'}.`;
            const message = formatSignalMessage({
              matchup: `${game.awayTeam} @ ${game.homeTeam}`,
              market: 'Totales 1ras 5 entradas',
              selection: `${side} ${line.point}`,
              price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning,
            });

            await recordSignal(db, { gamePk: game.gamePk, market: 'totals_f5', selection: `${side} ${line.point}`, price: line.price, impliedProb: implied, estimatedProb: prob, edgeValue, reasoning, message, sentMessages, line: line.point, existingSignalId });
          }
        }
      } catch (err) {
        console.error(`Failed to process F5 totals for game ${game.gamePk}:`, err);
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
