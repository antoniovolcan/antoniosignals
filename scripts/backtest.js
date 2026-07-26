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
// KNOWN METHODOLOGY DIFFERENCE FROM THE LIVE BOT: the live bot's pitcher-strikeout and moneyline/totals
// "opposing lineup" matchup factors average the top-5 individual batters' stats vs. the pitcher's hand.
// MLB's API silently ignores the hand filter when combined with a historical date range at the PLAYER
// level (confirmed empirically), so this backtest uses the TEAM's date-scoped vs-hand stats instead —
// a fair proxy, but not identical to the live methodology. Team-level date+hand filtering IS correctly
// applied by the API, and player-level date filtering (without a hand split) also works fine, which is
// why the batter-hits market below can still be backtested with real per-player, date-scoped accuracy.
import {
  fetchSchedule, parseScheduleGames, fetchPitcherGameLog, filterGameLogBefore,
  computeRecentEra, computeSeasonEra, computeRecentStrikeoutsPer9, computeInningsPerStartFromGameLog,
  extractPitcherName, fetchPersonInfo, extractPitchHand,
  fetchTeamRecentSchedule, computeLastTenFromSchedule, findMostRecentFinalGamePk, extractStartingLineup, fetchGameBoxscore,
  fetchTeamRoster, parseRoster,
  fetchTeamRecentHitting, extractRunsPerGame, extractOpsFromHittingStats, extractTeamStrikeoutRate,
  fetchTeamHittingByDateRangeVsHand, fetchBatterHittingByDateRange, extractBattingAvgAndPA, extractPowerContactProfile,
  fetchGameFeed, extractWeather,
  fetchGameLinescore, extractFinalScore, extractPlayerBattingHits, extractPlayerPitchingStrikeouts,
} from '../lib/mlb.js';
import {
  blendEraEstimates, computeOffensiveFactor, moneylineEstimate, projectedTotalRuns,
  computeAveragePowerContactFactor, adjustedInningsForEarlyHookRisk, computeWeatherFactorForStrikeouts,
  expectedPitcherStrikeouts,
} from '../lib/signals.js';
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
  return {
    name: extractPitcherName(fullLog) || 'desconocido',
    blendedEra: blendEraEstimates(recentEra, seasonEra),
    seasonEra, recentEra,
    pitcherK9: blendEraEstimates(recentK9, seasonK9),
    seasonK9, recentK9,
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

// Team-wide proxy for "opposing lineup vs. this pitcher hand" — see the methodology note at the top of the file.
async function computeTeamVsHandAsOf(teamId, hand, season, cutoffDate) {
  const raw = await fetchTeamHittingByDateRangeVsHand(teamId, hand, season, `${season}-03-01`, addDays(cutoffDate, -1));
  return {
    ops: extractOpsFromHittingStats(raw),
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

export async function processGame(game, season) {
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

  const [homeVsAwayHand, awayVsHomeHand] = await Promise.all([
    computeTeamVsHandAsOf(game.homeTeamId, awayPitchHand || 'R', season, game.date),
    computeTeamVsHandAsOf(game.awayTeamId, homePitchHand || 'R', season, game.date),
  ]);
  const homeOffensiveFactor = computeOffensiveFactor({ lineupOps: homeVsAwayHand.ops });
  const awayOffensiveFactor = computeOffensiveFactor({ lineupOps: awayVsHomeHand.ops });

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

  // --- Pitcher strikeouts + batter hits need the boxscore and weather ---
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

  const pitcherSides = [
    { pitcherId: homePitcherId, profile: homeProfile, ownEra: homeEra, opposingOffensiveFactor: awayOffensiveFactor, opposingVsHand: homeVsAwayHand },
    { pitcherId: awayPitcherId, profile: awayProfile, ownEra: awayEra, opposingOffensiveFactor: homeOffensiveFactor, opposingVsHand: awayVsHomeHand },
  ];
  for (const { pitcherId, profile, ownEra, opposingOffensiveFactor, opposingVsHand } of pitcherSides) {
    if (!pitcherId || !profile || !boxscore) continue;
    const actualK = extractPlayerPitchingStrikeouts(boxscore, pitcherId);
    if (actualK == null) continue; // pitcher didn't actually appear (scratched, etc.)

    const adjustedInnings = adjustedInningsForEarlyHookRisk({ baseInnings: profile.inningsPerStart, pitcherEra: ownEra, opposingOffensiveFactor });
    const powerContactFactor = computeAveragePowerContactFactor([opposingVsHand.powerContact]);
    const expectedK = expectedPitcherStrikeouts({
      pitcherK9: profile.pitcherK9, teamStrikeoutRate: opposingVsHand.strikeoutRate, expectedInnings: adjustedInnings,
      powerContactFactor, parkFactor, weatherFactor,
    });
    predictions.push({
      gamePk: game.gamePk, gameDate: game.date, market: 'pitcher_strikeouts', selection: profile.name, subjectId: pitcherId,
      homeTeam: game.homeTeam, awayTeam: game.awayTeam,
      projectedValue: expectedK, actualValue: actualK,
      factors: { pitcherK9: profile.pitcherK9, inningsPerStart: profile.inningsPerStart, adjustedInnings, ownEra, opposingOffensiveFactor, powerContactFactor, parkFactor, weatherFactor, opposingStrikeoutRate: opposingVsHand.strikeoutRate },
    });
  }

  // --- Batter hits: top 5 of each team's most-recently-known lineup ---
  if (boxscore) {
    const [homeLineup, awayLineup] = await Promise.all([fetchLineupAsOf(game.homeTeamId, game.date), fetchLineupAsOf(game.awayTeamId, game.date)]);
    let homeRoster = homeLineup;
    let awayRoster = awayLineup;
    if (!homeRoster) homeRoster = parseRoster(await fetchTeamRoster(game.homeTeamId));
    if (!awayRoster) awayRoster = parseRoster(await fetchTeamRoster(game.awayTeamId));

    for (const [roster, teamLabel] of [[homeRoster, game.homeTeam], [awayRoster, game.awayTeam]]) {
      for (const batter of roster.slice(0, 5)) {
        try {
          const actualHits = extractPlayerBattingHits(boxscore, batter.personId);
          if (actualHits == null) continue; // didn't play that day
          const raw = await fetchBatterHittingByDateRange(batter.personId, season, `${season}-03-01`, addDays(game.date, -1));
          const { avg, paPerGame } = extractBattingAvgAndPA(raw);
          const expectedRate = avg * paPerGame;
          predictions.push({
            gamePk: game.gamePk, gameDate: game.date, market: 'player_prop', selection: batter.fullName, subjectId: batter.personId,
            homeTeam: game.homeTeam, awayTeam: game.awayTeam,
            projectedValue: expectedRate, actualValue: actualHits,
            factors: { avg, paPerGame, team: teamLabel },
          });
        } catch (err) {
          // skip this batter, keep going
        }
      }
    }
  }

  return predictions;
}

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

  let totalPredictions = 0;
  for (const date of dateRange(startDate, endDate)) {
    const games = parseScheduleGames(await fetchSchedule(date)).map(g => ({ ...g, date }));
    const finalGames = games.filter(g => g.status === 'final');
    let dayPredictions = [];

    for (const game of finalGames) {
      try {
        const predictions = await processGame(game, season);
        dayPredictions = dayPredictions.concat(predictions);
      } catch (err) {
        console.error(`  ${date}: failed on game ${game.gamePk} (${game.awayTeam} @ ${game.homeTeam}):`, err.message);
      }
    }

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
