// scripts/backtest.js
// Usage: node --env-file=.env scripts/backtest.js <start-date YYYY-MM-DD> <end-date YYYY-MM-DD> ["model note"]
//
// Walk-forward backtest: for each date D in the range, reconstructs every input (pitcher ERA/K9,
// team runs/strikeout-rate, last-10 record, lineup-vs-hand matchup, park, weather) using ONLY data
// dated strictly before D, runs it through the exact same lib/signals.js functions the live bot uses,
// then grades the projection against the real result. No odds/edge/ROI involved — this measures raw
// prediction accuracy (bias, error, calibration) so the model itself can be tuned.
//
// Recommended start date: ~20 calendar days into the season, so ERA/K9/OPS samples aren't tiny-sample noise.
//
// INDIVIDUAL BATTER-VS-HAND DATA: MLB's API silently ignores the pitcher-hand filter when combined
// with a historical date range at the PLAYER level, so there's no direct endpoint for "this batter's
// stats vs. lefties, as of this past date". Instead, lib/battingLedger.js derives it ourselves from
// real play-by-play, processed in chronological order — a running ledger, primed from PRIMING_START
// through the day before this run's start date, then updated one day at a time as the walk-forward
// loop advances (always AFTER that day's predictions are made, never before, to stay leak-free). This
// gives the backtest the same per-batter, vs-hand-blended-with-overall fidelity as the live bot for
// the moneyline/totals offensive factor. The pitcher-strikeout market's "opposing lineup" K-rate and
// power/contact mix still use a team-level date-scoped proxy (team-level date+hand filtering DOES
// work correctly via the API) rather than the ledger — not yet upgraded to the per-batter approach.
import {
  fetchSchedule, parseScheduleGames, fetchPitcherGameLog, filterGameLogBefore,
  computeRecentEra, computeSeasonEra, computeRecentStrikeoutsPer9, computeInningsPerStartFromGameLog,
  extractPitcherName, fetchPersonInfo, extractPitchHand,
  fetchPitcherYearByYearStats, computeCareerEraBeforeSeason, computeCareerK9BeforeSeason,
  fetchTeamRecentSchedule, computeLastTenFromSchedule, findMostRecentFinalGamePk, extractStartingLineup, fetchGameBoxscore,
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
  expectedPitcherStrikeouts, CAREER_ERA_WEIGHT, CAREER_K9_WEIGHT,
} from '../lib/signals.js';
import { createLedger, updateLedgerFromPlateAppearances, getBatterLedgerProfile } from '../lib/battingLedger.js';
import { getStrikeoutParkFactor } from '../lib/parkFactors.js';
import { createDbClient, createBacktestRun, finishBacktestRun, insertBacktestPredictions } from '../lib/db.js';
import { pathToFileURL } from 'node:url';

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

// Caches that live for the whole run: a pitcher's full-season gameLog and throwing hand never need
// re-fetching once known — they're just re-filtered per cutoff date, which is cheap and leak-free.
const gameLogCache = new Map(); // pitcherId -> raw gameLog response
const pitchHandCache = new Map(); // pitcherId -> 'L' | 'R' | null
// A pitcher's prior-seasons career stats don't change day to day within a single backtest run
// (they're seasons strictly before the one being tested), so one fetch per pitcher is enough.
const yearByYearCache = new Map(); // pitcherId -> raw yearByYear response

async function getPitcherYearByYearStats(pitcherId) {
  if (!yearByYearCache.has(pitcherId)) {
    yearByYearCache.set(pitcherId, await fetchPitcherYearByYearStats(pitcherId));
  }
  return yearByYearCache.get(pitcherId);
}

async function getPitcherGameLog(pitcherId, season) {
  const key = `${pitcherId}:${season}`;
  if (!gameLogCache.has(key)) {
    gameLogCache.set(key, await fetchPitcherGameLog(pitcherId, season));
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
  const fullLog = await getPitcherGameLog(pitcherId, season);
  const filtered = filterGameLogBefore(fullLog, cutoffDate);
  const recentK9 = computeRecentStrikeoutsPer9(filtered);
  const seasonK9 = computeRecentStrikeoutsPer9(filtered, Infinity);
  const recentEra = computeRecentEra(filtered);
  const seasonEra = computeSeasonEra(filtered);
  const yearByYearRaw = await getPitcherYearByYearStats(pitcherId);
  // Pass `season`, not `cutoffDate` — career must be scoped to the year being backtested, not the
  // specific date, since prior seasons are equally "closed" history regardless of the exact day.
  const careerEra = computeCareerEraBeforeSeason(yearByYearRaw, season);
  const careerK9 = computeCareerK9BeforeSeason(yearByYearRaw, season);
  const recentSeasonEra = blendEraEstimates(recentEra, seasonEra);
  const recentSeasonK9 = blendEraEstimates(recentK9, seasonK9);
  return {
    name: extractPitcherName(fullLog) || 'desconocido',
    blendedEra: careerEra == null ? recentSeasonEra : blendEraEstimates(recentSeasonEra, careerEra, CAREER_ERA_WEIGHT),
    seasonEra, recentEra, careerEra,
    pitcherK9: careerK9 == null ? recentSeasonK9 : blendEraEstimates(recentSeasonK9, careerK9, CAREER_K9_WEIGHT),
    seasonK9, recentK9, careerK9,
    inningsPerStart: computeInningsPerStartFromGameLog(filtered),
  };
}

async function computeLastTenAsOf(teamId, cutoffDate) {
  const schedule = await fetchTeamRecentSchedule(teamId, addDays(cutoffDate, -25), addDays(cutoffDate, -1));
  return computeLastTenFromSchedule(schedule, teamId);
}

async function computeTeamRunsAsOf(teamId, season, cutoffDate) {
  const [seasonHitting, recentHitting] = await Promise.all([
    fetchTeamRecentHitting(teamId, season, `${season}-03-01`, addDays(cutoffDate, -1)),
    fetchTeamRecentHitting(teamId, season, addDays(cutoffDate, -15), addDays(cutoffDate, -1)),
  ]);
  return {
    seasonRunsPerGame: extractRunsPerGame(seasonHitting),
    recentRunsPerGame: extractRunsPerGame(recentHitting),
    recentOverallKRate: extractTeamStrikeoutRate(recentHitting),
  };
}

// Team-wide proxy for the pitcher-strikeout market's "opposing lineup" K-rate and power/contact mix.
// Not used for the offensive factor anymore — that's now individual, via the batting ledger below.
async function computeTeamStrikeoutMatchupAsOf(teamId, hand, season, cutoffDate) {
  const raw = await fetchTeamHittingByDateRangeVsHand(teamId, hand, season, `${season}-03-01`, addDays(cutoffDate, -1));
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

const OFFENSIVE_FACTOR_LINEUP_SIZE = 9; // full projected batting order, not just the top 5 — must match scan.js

// Per batter, blends his ledger OPS specifically vs. this hand with his overall ledger OPS (50/50) —
// same idea as the live bot: a single-season vs-hand split can be a small, noisy sample. Batters with
// no ledger data yet (e.g. rookies, or too early in the priming window) are simply skipped;
// computeLineupOps falls back gracefully if too few batters have data.
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
  if (!score) return predictions; // not actually final / no score available, skip

  const [homeLast10, awayLast10, homeRuns, awayRuns] = await Promise.all([
    computeLastTenAsOf(game.homeTeamId, game.date),
    computeLastTenAsOf(game.awayTeamId, game.date),
    computeTeamRunsAsOf(game.homeTeamId, season, game.date),
    computeTeamRunsAsOf(game.awayTeamId, season, game.date),
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

  // --- Moneyline ---
  const homeWinProb = moneylineEstimate({
    home: { last10WinPct: homeLast10, startingPitcherEra: homeEra, offensiveFactor: homeOffensiveFactor },
    away: { last10WinPct: awayLast10, startingPitcherEra: awayEra, offensiveFactor: awayOffensiveFactor },
  });
  predictions.push({
    gamePk: game.gamePk, gameDate: game.date, market: 'moneyline', selection: game.homeTeam,
    homeTeam: game.homeTeam, awayTeam: game.awayTeam,
    projectedProb: homeWinProb, actualOutcome: score.home > score.away,
    factors: { homeEra, awayEra, homeLast10, awayLast10, homeOffensiveFactor, awayOffensiveFactor, homeScore: score.home, awayScore: score.away },
  });

  // --- Totals ---
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

  // --- Totals, first 5 innings ---
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

  // --- Pitcher strikeouts need the boxscore, weather, and the team-level strikeout matchup ---
  let boxscore = null;
  let weather = { tempF: null, windMph: 0, windDirection: '', condition: null };
  try {
    boxscore = await fetchGameBoxscore(game.gamePk);
  } catch (err) { /* leave null, strikeouts/hits just get skipped below */ }
  try {
    weather = extractWeather(await fetchGameFeed(game.gamePk));
  } catch (err) { /* best-effort */ }
  const weatherFactor = computeWeatherFactorForStrikeouts(weather);
  const parkFactor = getStrikeoutParkFactor(game.homeTeam);

  const [homeStrikeoutMatchup, awayStrikeoutMatchup] = await Promise.all([
    computeTeamStrikeoutMatchupAsOf(game.homeTeamId, awayPitchHand || 'R', season, game.date),
    computeTeamStrikeoutMatchupAsOf(game.awayTeamId, homePitchHand || 'R', season, game.date),
  ]);

  // homeStrikeoutMatchup describes the HOME team's batters (vs. the away pitcher's hand) — that's
  // the AWAY pitcher's opponent, not his own. Bug found during a data audit: these were swapped,
  // so each pitcher's "opposing lineup" K-rate/power-contact was actually his own team's batters.
  const pitcherSides = [
    { pitcherId: homePitcherId, profile: homeProfile, ownEra: homeEra, opposingOffensiveFactor: awayOffensiveFactor, opposingMatchup: awayStrikeoutMatchup },
    { pitcherId: awayPitcherId, profile: awayProfile, ownEra: awayEra, opposingOffensiveFactor: homeOffensiveFactor, opposingMatchup: homeStrikeoutMatchup },
  ];
  for (const { pitcherId, profile, ownEra, opposingOffensiveFactor, opposingMatchup } of pitcherSides) {
    if (!pitcherId || !profile || !boxscore) continue;
    const actualK = extractPlayerPitchingStrikeouts(boxscore, pitcherId);
    if (actualK == null) continue; // pitcher didn't actually appear (scratched, etc.)

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

// Feeds a day's real plate appearances into the ledger — call ONLY after that day's predictions
// have already been computed, so the ledger never leaks same-day or future information.
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

const PRIMING_START_MONTH_DAY = '03-20'; // a few days after typical Opening Day, close enough

async function main() {
  const [, , startDate, endDate, modelNote] = process.argv;
  if (!startDate || !endDate) {
    console.error('Usage: node --env-file=.env scripts/backtest.js <start-date YYYY-MM-DD> <end-date YYYY-MM-DD> ["model note"]');
    process.exit(1);
  }
  const db = createDbClient();
  const season = new Date(startDate).getFullYear();
  const runId = await createBacktestRun(db, { fromDate: startDate, toDate: endDate, modelNote });
  console.log(`Backtest run #${runId}: ${startDate} to ${endDate}${modelNote ? ` (${modelNote})` : ''}`);

  const ledger = createLedger();
  const primingStart = `${season}-${PRIMING_START_MONTH_DAY}`;
  const primingDates = dateRange(primingStart, addDays(startDate, -1));
  console.log(`Calentando la libreta de bateo: ${primingStart} a ${addDays(startDate, -1)} (${primingDates.length} días)...`);
  for (const [i, date] of primingDates.entries()) {
    const finalGames = await fetchFinalGamesForDate(date);
    await updateLedgerWithGames(ledger, finalGames, date);
    process.stdout.write(`\r  Calentando ${i + 1}/${primingDates.length} (${date})...`);
  }
  console.log(`\nLibreta lista: ${ledger.size} bateadores con datos.`);

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
  console.log(`Listo. Run #${runId}: ${totalPredictions} predicciones guardadas en total.`);
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(err => {
    console.error('Backtest failed:', err);
    process.exit(1);
  });
}
