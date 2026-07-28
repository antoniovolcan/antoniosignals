// scripts/backtest-season-glue.js
// EXPERIMENT ONLY — not used by the live bot, not the production backtest. Do not wire into scan.js.
//
// Usage: node --env-file=.env scripts/backtest-season-glue.js <start-date YYYY-MM-DD> <end-date YYYY-MM-DD>
// Intended for April 2026 dates specifically.
//
// Question being tested: does "gluing" the 2025 season directly onto the start of 2026 (using 2025
// stats as the prior for pitchers/teams/batters, instead of the live bot's real cold-start behavior)
// change April's prediction accuracy? If it helps a lot, that's a case for eventually teaching the
// live bot to use prior-season stats early in a season. If it doesn't help much, April's rough numbers
// are just inherent to a new season (rotations settling, roster churn) and not fixable this way.
//
// Every "as of" input now reaches back across the 2025/2026 boundary instead of stopping at the
// current season's Opening Day:
//   - Pitcher ERA/K9: game logs from BOTH season=2025 and season=2026 are fetched and merged, then
//     filtered/blended as usual (gameLog is season-scoped by the API, so this needs two fetches).
//   - Team runs-per-game / team strikeout-rate-vs-hand: byDateRange happily spans the year boundary
//     in a single call (confirmed empirically — the `season` query param doesn't actually restrict
//     byDateRange results), so these just use a start date back in 2025.
//   - Team last-10 record: fetchTeamRecentSchedule has no season param at all, so this already spans
//     years; just widened the lookback window so it reaches real games even on April 1.
//   - Individual batter-vs-hand ledger: primed from the 2025 season opener all the way through the
//     day before this run's start date, instead of the current season's Opening Day. This is the
//     expensive part (~200 extra days of play-by-play fetches) but it's what "all the stats" means.
import {
  fetchSchedule, parseScheduleGames, fetchPitcherGameLog, filterGameLogBefore,
  computeRecentEra, computeSeasonEra, computeRecentStrikeoutsPer9, computeInningsPerStartFromGameLog,
  extractPitcherName, fetchPersonInfo, extractPitchHand,
  fetchTeamRecentSchedule, computeWinPctFromSchedule, findMostRecentFinalGamePk, extractStartingLineup, fetchGameBoxscore,
  fetchTeamRoster, parseRoster,
  fetchTeamRecentHitting, extractRunsPerGame, extractTeamStrikeoutRate,
  fetchTeamHittingByDateRangeVsHand, extractPowerContactProfile,
  fetchGameFeed, extractWeather,
  fetchGameLinescore, extractFinalScore, extractFirstFiveInningsScore, extractPlayerPitchingStrikeouts,
  fetchPlayByPlay, extractPlateAppearances,
} from '../lib/mlb.js';
import {
  blendEraEstimates, computeOffensiveFactor, computeLineupOps, LEAGUE_AVG_TOP_WEIGHTED_OPS, moneylineEstimate, projectedTotalRuns, projectedFirstFiveInningsRuns,
  computeAveragePowerContactFactor, adjustedInningsForEarlyHookRisk, computeWeatherFactorForStrikeouts,
  expectedPitcherStrikeouts,
} from '../lib/signals.js';
import { createLedger, updateLedgerFromPlateAppearances, getBatterLedgerProfile } from '../lib/battingLedger.js';
import { getStrikeoutParkFactor } from '../lib/parkFactors.js';
import { createDbClient, createBacktestRun, finishBacktestRun, insertBacktestPredictions } from '../lib/db.js';
import { pathToFileURL } from 'node:url';

const PRIOR_SEASON = 2025;
const PRIOR_SEASON_START = '2025-03-18'; // 2025 season opener (Tokyo Series)

function dateRange(start, end) {
  const dates = [];
  let current = new Date(start);
  const last = new Date(end);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mergeGameLogs(logA, logB) {
  return { stats: [{ splits: [...(logA.stats?.[0]?.splits || []), ...(logB.stats?.[0]?.splits || [])] }] };
}

const gameLogCache = new Map();
const pitchHandCache = new Map();

// Pitcher game logs are season-scoped by the API — fetch both 2025 and the current season, merge.
async function getGluedPitcherGameLog(pitcherId, currentSeason) {
  const key = `${pitcherId}:${currentSeason}`;
  if (!gameLogCache.has(key)) {
    const [priorLog, currentLog] = await Promise.all([
      fetchPitcherGameLog(pitcherId, PRIOR_SEASON).catch(() => ({ stats: [{ splits: [] }] })),
      fetchPitcherGameLog(pitcherId, currentSeason).catch(() => ({ stats: [{ splits: [] }] })),
    ]);
    gameLogCache.set(key, mergeGameLogs(priorLog, currentLog));
  }
  return gameLogCache.get(key);
}

async function getPitchHand(pitcherId) {
  if (!pitchHandCache.has(pitcherId)) {
    try {
      const info = await fetchPersonInfo(pitcherId);
      pitchHandCache.set(pitcherId, extractPitchHand(info));
    } catch (err) {
      pitchHandCache.set(pitcherId, null);
    }
  }
  return pitchHandCache.get(pitcherId);
}

async function computePitcherProfileAsOf(pitcherId, season, cutoffDate) {
  const fullLog = await getGluedPitcherGameLog(pitcherId, season);
  const filtered = filterGameLogBefore(fullLog, cutoffDate);
  const recentK9 = computeRecentStrikeoutsPer9(filtered);
  const seasonK9 = computeRecentStrikeoutsPer9(filtered, Infinity);
  const recentEra = computeRecentEra(filtered);
  const seasonEra = computeSeasonEra(filtered);
  return {
    name: extractPitcherName(fullLog) || 'desconocido',
    blendedEra: blendEraEstimates(recentEra, seasonEra),
    seasonEra, recentEra,
    pitcherK9: blendEraEstimates(recentK9, seasonK9),
    seasonK9, recentK9,
    inningsPerStart: computeInningsPerStartFromGameLog(filtered),
  };
}

// Widened from the production script's 25 days so it reaches real completed games even on
// April 1st of the new season (last 10 games might mean late-September 2025 games).
async function computeLastTenAsOf(teamId, cutoffDate) {
  const schedule = await fetchTeamRecentSchedule(teamId, addDays(cutoffDate, -90), addDays(cutoffDate, -1));
  return computeWinPctFromSchedule(schedule, teamId, { lastN: 10 });
}

async function computeTeamRunsAsOf(teamId, cutoffDate) {
  const [seasonHitting, recentHitting] = await Promise.all([
    fetchTeamRecentHitting(teamId, PRIOR_SEASON, PRIOR_SEASON_START, addDays(cutoffDate, -1)),
    fetchTeamRecentHitting(teamId, PRIOR_SEASON, addDays(cutoffDate, -15), addDays(cutoffDate, -1)),
  ]);
  return {
    seasonRunsPerGame: extractRunsPerGame(seasonHitting),
    recentRunsPerGame: extractRunsPerGame(recentHitting),
    recentOverallKRate: extractTeamStrikeoutRate(recentHitting),
  };
}

async function computeTeamStrikeoutMatchupAsOf(teamId, hand, cutoffDate) {
  const raw = await fetchTeamHittingByDateRangeVsHand(teamId, hand, PRIOR_SEASON, PRIOR_SEASON_START, addDays(cutoffDate, -1));
  return {
    strikeoutRate: extractTeamStrikeoutRate(raw),
    powerContact: extractPowerContactProfile(raw),
  };
}

async function fetchLineupAsOf(teamId, gameDate) {
  try {
    const schedule = await fetchTeamRecentSchedule(teamId, addDays(gameDate, -10), addDays(gameDate, -1));
    const gamePk = findMostRecentFinalGamePk(schedule);
    if (!gamePk) return null;
    const boxscore = await fetchGameBoxscore(gamePk);
    const lineup = extractStartingLineup(boxscore, teamId);
    return lineup.length > 0 ? lineup : null;
  } catch (err) {
    return null;
  }
}

async function resolveRoster(teamId, gameDate) {
  const lineup = await fetchLineupAsOf(teamId, gameDate);
  if (lineup) return lineup;
  return parseRoster(await fetchTeamRoster(teamId));
}

const OFFENSIVE_FACTOR_LINEUP_SIZE = 9;

function computeLineupOpsFromLedger(ledger, lineup, hand) {
  const batterOpsList = lineup.slice(0, OFFENSIVE_FACTOR_LINEUP_SIZE).map(batter => {
    const profile = getBatterLedgerProfile(ledger, batter.personId, hand);
    if (!profile) return null;
    const vsHandOps = profile.vsHand?.ops ?? null;
    const overallOps = profile.overall?.ops ?? null;
    if (vsHandOps == null && overallOps == null) return null;
    if (vsHandOps == null) return overallOps;
    if (overallOps == null) return vsHandOps;
    return blendEraEstimates(vsHandOps, overallOps, 0.5);
  });
  return computeLineupOps({ batterOpsList, topWeight: 0.7, leagueAvgOps: LEAGUE_AVG_TOP_WEIGHTED_OPS });
}

export async function processGame(game, season, ledger) {
  const predictions = [];
  const linescoreRaw = await fetchGameLinescore(game.gamePk);
  const score = extractFinalScore(linescoreRaw);
  if (!score) return predictions;

  const [homeLast10, awayLast10, homeRuns, awayRuns] = await Promise.all([
    computeLastTenAsOf(game.homeTeamId, game.date),
    computeLastTenAsOf(game.awayTeamId, game.date),
    computeTeamRunsAsOf(game.homeTeamId, game.date),
    computeTeamRunsAsOf(game.awayTeamId, game.date),
  ]);

  const homePitcherId = game.homeProbablePitcherId;
  const awayPitcherId = game.awayProbablePitcherId;
  const [homeProfile, awayProfile] = await Promise.all([
    homePitcherId ? computePitcherProfileAsOf(homePitcherId, season, game.date) : null,
    awayPitcherId ? computePitcherProfileAsOf(awayPitcherId, season, game.date) : null,
  ]);
  const [homePitchHand, awayPitchHand] = await Promise.all([
    homePitcherId ? getPitchHand(homePitcherId) : null,
    awayPitcherId ? getPitchHand(awayPitcherId) : null,
  ]);

  const [homeRoster, awayRoster] = await Promise.all([
    resolveRoster(game.homeTeamId, game.date),
    resolveRoster(game.awayTeamId, game.date),
  ]);
  const homeLineupOps = computeLineupOpsFromLedger(ledger, homeRoster, awayPitchHand || 'R');
  const awayLineupOps = computeLineupOpsFromLedger(ledger, awayRoster, homePitchHand || 'R');
  const homeOffensiveFactor = computeOffensiveFactor({ lineupOps: homeLineupOps, leagueAvgOps: LEAGUE_AVG_TOP_WEIGHTED_OPS });
  const awayOffensiveFactor = computeOffensiveFactor({ lineupOps: awayLineupOps, leagueAvgOps: LEAGUE_AVG_TOP_WEIGHTED_OPS });

  const homeEra = homeProfile?.blendedEra ?? 4.00;
  const awayEra = awayProfile?.blendedEra ?? 4.00;

  const homeWinProb = moneylineEstimate({
    home: { recordWinPct: homeLast10, startingPitcherEra: homeEra, offensiveFactor: homeOffensiveFactor },
    away: { recordWinPct: awayLast10, startingPitcherEra: awayEra, offensiveFactor: awayOffensiveFactor },
  });
  predictions.push({
    gamePk: game.gamePk, gameDate: game.date, market: 'moneyline', selection: game.homeTeam,
    homeTeam: game.homeTeam, awayTeam: game.awayTeam,
    projectedProb: homeWinProb, actualOutcome: score.home > score.away,
    factors: { homeEra, awayEra, homeLast10, awayLast10, homeOffensiveFactor, awayOffensiveFactor, homeScore: score.home, awayScore: score.away },
  });

  const homeBlendedRPG = blendEraEstimates(homeRuns.recentRunsPerGame, homeRuns.seasonRunsPerGame);
  const awayBlendedRPG = blendEraEstimates(awayRuns.recentRunsPerGame, awayRuns.seasonRunsPerGame);
  const projectedTotal = projectedTotalRuns({
    home: { runsPerGame: homeBlendedRPG * homeOffensiveFactor, startingPitcherEra: homeEra },
    away: { runsPerGame: awayBlendedRPG * awayOffensiveFactor, startingPitcherEra: awayEra },
  });
  predictions.push({
    gamePk: game.gamePk, gameDate: game.date, market: 'totals', selection: 'total_runs',
    homeTeam: game.homeTeam, awayTeam: game.awayTeam,
    projectedValue: projectedTotal, actualValue: score.home + score.away,
    factors: { homeBlendedRPG, awayBlendedRPG, homeEra, awayEra, homeOffensiveFactor, awayOffensiveFactor, homeScore: score.home, awayScore: score.away },
  });

  const f5Score = extractFirstFiveInningsScore(linescoreRaw);
  if (f5Score) {
    const projectedF5Total = projectedFirstFiveInningsRuns({
      home: { runsPerGame: homeBlendedRPG * homeOffensiveFactor, startingPitcherEra: homeEra },
      away: { runsPerGame: awayBlendedRPG * awayOffensiveFactor, startingPitcherEra: awayEra },
    });
    predictions.push({
      gamePk: game.gamePk, gameDate: game.date, market: 'totals_f5', selection: 'total_runs_f5',
      homeTeam: game.homeTeam, awayTeam: game.awayTeam,
      projectedValue: projectedF5Total, actualValue: f5Score.home + f5Score.away,
      factors: { homeBlendedRPG, awayBlendedRPG, homeEra, awayEra, homeOffensiveFactor, awayOffensiveFactor, homeScoreF5: f5Score.home, awayScoreF5: f5Score.away },
    });
  }

  let boxscore = null;
  let weather = { tempF: null, windMph: 0, windDirection: '', condition: null };
  try {
    boxscore = await fetchGameBoxscore(game.gamePk);
  } catch (err) { /* leave null */ }
  try {
    weather = extractWeather(await fetchGameFeed(game.gamePk));
  } catch (err) { /* best-effort */ }
  const weatherFactor = computeWeatherFactorForStrikeouts(weather);
  const parkFactor = getStrikeoutParkFactor(game.homeTeam);

  const [homeStrikeoutMatchup, awayStrikeoutMatchup] = await Promise.all([
    computeTeamStrikeoutMatchupAsOf(game.homeTeamId, awayPitchHand || 'R', game.date),
    computeTeamStrikeoutMatchupAsOf(game.awayTeamId, homePitchHand || 'R', game.date),
  ]);

  const pitcherSides = [
    { pitcherId: homePitcherId, profile: homeProfile, ownEra: homeEra, opposingOffensiveFactor: awayOffensiveFactor, opposingMatchup: awayStrikeoutMatchup },
    { pitcherId: awayPitcherId, profile: awayProfile, ownEra: awayEra, opposingOffensiveFactor: homeOffensiveFactor, opposingMatchup: homeStrikeoutMatchup },
  ];
  for (const { pitcherId, profile, ownEra, opposingOffensiveFactor, opposingMatchup } of pitcherSides) {
    if (!pitcherId || !profile || !boxscore) continue;
    const actualK = extractPlayerPitchingStrikeouts(boxscore, pitcherId);
    if (actualK == null) continue;

    const adjustedInnings = adjustedInningsForEarlyHookRisk({ baseInnings: profile.inningsPerStart, pitcherEra: ownEra, opposingOffensiveFactor });
    const powerContactFactor = computeAveragePowerContactFactor([opposingMatchup.powerContact]);
    const expectedK = expectedPitcherStrikeouts({
      pitcherK9: profile.pitcherK9, teamStrikeoutRate: opposingMatchup.strikeoutRate, expectedInnings: adjustedInnings,
      powerContactFactor, parkFactor, weatherFactor,
    });
    predictions.push({
      gamePk: game.gamePk, gameDate: game.date, market: 'pitcher_strikeouts', selection: profile.name, subjectId: pitcherId,
      homeTeam: game.homeTeam, awayTeam: game.awayTeam,
      projectedValue: expectedK, actualValue: actualK,
      factors: { pitcherK9: profile.pitcherK9, inningsPerStart: profile.inningsPerStart, adjustedInnings, ownEra, opposingOffensiveFactor, powerContactFactor, parkFactor, weatherFactor, opposingStrikeoutRate: opposingMatchup.strikeoutRate },
    });
  }

  return predictions;
}

async function fetchFinalGamesForDate(date) {
  const games = parseScheduleGames(await fetchSchedule(date)).map(g => ({ ...g, date }));
  return games.filter(g => g.status === 'final');
}

async function updateLedgerWithGames(ledger, finalGames, dateLabel) {
  for (const game of finalGames) {
    try {
      const pbp = await fetchPlayByPlay(game.gamePk);
      updateLedgerFromPlateAppearances(ledger, extractPlateAppearances(pbp));
    } catch (err) {
      console.error(`  Error actualizando la libreta con el partido ${game.gamePk} (${dateLabel}):`, err.message);
    }
  }
}

async function main() {
  const [, , startDate, endDate] = process.argv;
  if (!startDate || !endDate) {
    console.error('Usage: node --env-file=.env scripts/backtest-season-glue.js <start-date YYYY-MM-DD> <end-date YYYY-MM-DD>');
    process.exit(1);
  }
  const modelNote = 'EXPERIMENTO: temporada 2025 pegada a 2026 (todos los stats de pitchers/equipos/bateadores incluyen 2025) — NO aplicar al bot en vivo';
  const db = createDbClient();
  const season = new Date(startDate).getFullYear();
  const runId = await createBacktestRun(db, { fromDate: startDate, toDate: endDate, modelNote });
  console.log(`[EXPERIMENTO] Backtest run #${runId}: ${startDate} to ${endDate}`);
  console.log(modelNote);

  const ledger = createLedger();
  const primingDates = dateRange(PRIOR_SEASON_START, addDays(startDate, -1));
  console.log(`Calentando la libreta de bateo desde la temporada 2025: ${PRIOR_SEASON_START} a ${addDays(startDate, -1)} (${primingDates.length} días — esto va a tardar bastante)...`);
  for (const [i, date] of primingDates.entries()) {
    const finalGames = await fetchFinalGamesForDate(date);
    await updateLedgerWithGames(ledger, finalGames, date);
    if (i % 10 === 0 || i === primingDates.length - 1) {
      process.stdout.write(`\r  Calentando ${i + 1}/${primingDates.length} (${date})...`);
    }
  }
  console.log(`\nLibreta lista: ${ledger.size} bateadores con datos (temporada 2025 + lo que va de 2026).`);

  let totalPredictions = 0;
  for (const date of dateRange(startDate, endDate)) {
    const finalGames = await fetchFinalGamesForDate(date);
    let dayPredictions = [];

    for (const game of finalGames) {
      try {
        const predictions = await processGame(game, season, ledger);
        dayPredictions = dayPredictions.concat(predictions);
      } catch (err) {
        console.error(`  ${date}: failed on game ${game.gamePk} (${game.awayTeam} @ ${game.homeTeam}):`, err.message);
      }
    }

    await updateLedgerWithGames(ledger, finalGames, date);

    if (dayPredictions.length > 0) {
      await insertBacktestPredictions(db, dayPredictions.map(p => ({ ...p, runId })));
      totalPredictions += dayPredictions.length;
    }
    console.log(`  ${date}: ${finalGames.length} juegos, ${dayPredictions.length} predicciones guardadas`);
  }

  await finishBacktestRun(db, runId);
  console.log(`Listo. Run #${runId} (EXPERIMENTO): ${totalPredictions} predicciones guardadas en total.`);
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(err => {
    console.error('Backtest failed:', err);
    process.exit(1);
  });
}
