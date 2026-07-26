// lib/mlb.js
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const GAME_STATUS_MAP = {
  'Scheduled': 'scheduled',
  'Pre-Game': 'scheduled',
  'Warmup': 'scheduled',
  'In Progress': 'live',
  'Final': 'final',
  'Game Over': 'final',
  'Postponed': 'postponed',
  'Cancelled': 'postponed',
  'Suspended': 'postponed',
};

export function mapGameStatus(detailedState) {
  return GAME_STATUS_MAP[detailedState] || 'scheduled';
}

export function parseScheduleGames(scheduleResponse) {
  const games = [];
  for (const d of scheduleResponse.dates || []) {
    for (const g of d.games || []) {
      games.push({
        gamePk: g.gamePk,
        status: mapGameStatus(g.status.detailedState),
        homeTeam: g.teams.home.team.name,
        awayTeam: g.teams.away.team.name,
        homeTeamId: g.teams.home.team.id,
        awayTeamId: g.teams.away.team.id,
        homeProbablePitcherId: g.teams.home.probablePitcher?.id ?? null,
        awayProbablePitcherId: g.teams.away.probablePitcher?.id ?? null,
      });
    }
  }
  return games;
}

export async function fetchSchedule(date) {
  const res = await fetch(`${MLB_API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher`);
  if (!res.ok) throw new Error(`MLB schedule fetch failed: ${res.status}`);
  return res.json();
}

const LEAGUE_AVG_ERA_FALLBACK = 4.00;

export function parseLastTenRecord(standingsResponse, teamId) {
  for (const record of standingsResponse.records || []) {
    for (const teamRecord of record.teamRecords || []) {
      if (teamRecord.team.id === teamId) {
        const lastTen = (teamRecord.records.splitRecords || []).find(r => r.type === 'lastTen');
        if (!lastTen) return 0.5;
        const total = lastTen.wins + lastTen.losses;
        return total === 0 ? 0.5 : lastTen.wins / total;
      }
    }
  }
  return 0.5;
}

export async function fetchStandings(season) {
  const res = await fetch(`${MLB_API}/standings?leagueId=103,104&season=${season}`);
  if (!res.ok) throw new Error(`MLB standings fetch failed: ${res.status}`);
  return res.json();
}

function inningsPitchedToOuts(ipString) {
  const [whole, partial = '0'] = String(ipString).split('.');
  return Number(whole) * 3 + Number(partial);
}

export function computeRecentEra(gameLogResponse, lastN = 5) {
  const splits = gameLogResponse.stats?.[0]?.splits || [];
  const sorted = [...splits].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const recent = sorted.slice(0, lastN);
  if (recent.length === 0) return LEAGUE_AVG_ERA_FALLBACK;
  const earnedRuns = recent.reduce((sum, s) => sum + Number(s.stat.earnedRuns || 0), 0);
  const outs = recent.reduce((sum, s) => sum + inningsPitchedToOuts(s.stat.inningsPitched || '0.0'), 0);
  const inningsPitched = outs / 3;
  if (inningsPitched === 0) return LEAGUE_AVG_ERA_FALLBACK;
  return (earnedRuns * 9) / inningsPitched;
}

export function computeSeasonEra(gameLogResponse) {
  return computeRecentEra(gameLogResponse, Infinity);
}

export function extractPitcherName(gameLogResponse) {
  const splits = gameLogResponse.stats?.[0]?.splits || [];
  return splits[0]?.player?.fullName || null;
}

export async function fetchPitcherGameLog(personId, season) {
  const res = await fetch(`${MLB_API}/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`);
  if (!res.ok) throw new Error(`MLB pitcher gamelog fetch failed: ${res.status}`);
  return res.json();
}

export function extractBattingAvgAndPA(batterStatsResponse) {
  const split = batterStatsResponse.stats?.[0]?.splits?.[0];
  if (!split) return { avg: 0.240, paPerGame: 4.3 };
  const stat = split.stat;
  const games = Number(stat.gamesPlayed);
  if (!games) return { avg: 0.240, paPerGame: 4.3 };
  const avgNumber = Number(stat.avg);
  const avg = Number.isFinite(avgNumber) ? avgNumber : 0.240;
  const plateAppearances = stat.plateAppearances != null ? Number(stat.plateAppearances) : games * 4.3;
  return {
    avg,
    paPerGame: plateAppearances / games,
  };
}

export async function fetchBatterSeasonStats(personId, season) {
  const res = await fetch(`${MLB_API}/people/${personId}/stats?stats=season&group=hitting&season=${season}`);
  if (!res.ok) throw new Error(`MLB batter stats fetch failed: ${res.status}`);
  return res.json();
}

export function parseRoster(rosterResponse) {
  return (rosterResponse.roster || []).map(entry => ({
    personId: entry.person.id,
    fullName: entry.person.fullName,
  }));
}

export async function fetchTeamRoster(teamId) {
  const res = await fetch(`${MLB_API}/teams/${teamId}/roster`);
  if (!res.ok) throw new Error(`MLB roster fetch failed: ${res.status}`);
  return res.json();
}

const LEAGUE_AVG_K_PER_9 = 8.5;

export async function fetchPitcherSeasonStats(personId, season) {
  const res = await fetch(`${MLB_API}/people/${personId}/stats?stats=season&group=pitching&season=${season}`);
  if (!res.ok) throw new Error(`MLB pitcher season stats fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchPersonInfo(personId) {
  const res = await fetch(`${MLB_API}/people/${personId}`);
  if (!res.ok) throw new Error(`MLB person info fetch failed: ${res.status}`);
  return res.json();
}

export function extractPitchHand(personInfoResponse) {
  return personInfoResponse.people?.[0]?.pitchHand?.code || null;
}

export function extractStrikeoutsPer9(pitcherSeasonStatsResponse) {
  const split = pitcherSeasonStatsResponse.stats?.[0]?.splits?.[0];
  if (!split) return LEAGUE_AVG_K_PER_9;
  const stat = split.stat;
  const strikeOuts = Number(stat.strikeOuts || 0);
  const outs = inningsPitchedToOuts(stat.inningsPitched || '0.0');
  const inningsPitched = outs / 3;
  if (inningsPitched === 0) return LEAGUE_AVG_K_PER_9;
  return (strikeOuts * 9) / inningsPitched;
}

const AVG_INNINGS_PER_START_FALLBACK = 5.5;

export function extractInningsPerStart(pitcherSeasonStatsResponse) {
  const split = pitcherSeasonStatsResponse.stats?.[0]?.splits?.[0];
  if (!split) return AVG_INNINGS_PER_START_FALLBACK;
  const stat = split.stat;
  const gamesStarted = Number(stat.gamesStarted || 0);
  if (gamesStarted === 0) return AVG_INNINGS_PER_START_FALLBACK;
  const outs = inningsPitchedToOuts(stat.inningsPitched || '0.0');
  return (outs / 3) / gamesStarted;
}

// Backtesting-only helper: restricts a full-season gameLog response to splits strictly before
// cutoffDate, so downstream functions (computeRecentEra, computeSeasonEra, computeRecentStrikeoutsPer9,
// extractPitcherName, computeInningsPerStartFromGameLog) only ever see data that existed at that point
// in the season — required to backtest without leaking future information into the projection.
export function filterGameLogBefore(gameLogResponse, cutoffDate) {
  const splits = gameLogResponse.stats?.[0]?.splits || [];
  return { stats: [{ splits: splits.filter(s => (s.date || '') < cutoffDate) }] };
}

// Like extractInningsPerStart, but derived from a (possibly date-filtered) gameLog instead of the
// live season-stats endpoint, since that endpoint only ever reflects the season-to-date-as-of-now.
export function computeInningsPerStartFromGameLog(gameLogResponse) {
  const splits = gameLogResponse.stats?.[0]?.splits || [];
  const starts = splits.filter(s => Number(s.stat?.gamesStarted || 0) === 1);
  if (starts.length === 0) return AVG_INNINGS_PER_START_FALLBACK;
  const outs = starts.reduce((sum, s) => sum + inningsPitchedToOuts(s.stat.inningsPitched || '0.0'), 0);
  return (outs / 3) / starts.length;
}

// Like parseLastTenRecord, but computed from a team-schedule response (which already carries each
// game's final score/winner) instead of the live standings endpoint, which only reflects the team's
// CURRENT record — needed to backtest a team's "last 10" as it stood on a past date.
export function computeLastTenFromSchedule(scheduleResponse, teamId) {
  const finals = [];
  for (const d of scheduleResponse.dates || []) {
    for (const g of d.games || []) {
      if (g.status?.detailedState !== 'Final') continue;
      const side = g.teams?.home?.team?.id === teamId ? g.teams.home : g.teams?.away?.team?.id === teamId ? g.teams.away : null;
      if (!side) continue;
      finals.push({ date: d.date, isWinner: !!side.isWinner });
    }
  }
  finals.sort((a, b) => b.date.localeCompare(a.date));
  const lastTen = finals.slice(0, 10);
  if (lastTen.length === 0) return 0.5;
  return lastTen.filter(g => g.isWinner).length / lastTen.length;
}

// Team-level byDateRange + sitCodes IS correctly filtered by the MLB API (confirmed empirically);
// the player-level equivalent is not (sitCodes is silently ignored when combined with byDateRange
// at /people/{id}/stats), so backtesting the "opposing lineup vs. this hand" matchup uses this
// team-wide figure instead of averaging individual batters like the live model does.
export async function fetchTeamHittingByDateRangeVsHand(teamId, hand, season, startDate, endDate) {
  const sitCode = hand === 'L' ? 'vl' : 'vr';
  const res = await fetch(`${MLB_API}/teams/${teamId}/stats?stats=byDateRange&group=hitting&sitCodes=${sitCode}&season=${season}&startDate=${startDate}&endDate=${endDate}`);
  if (!res.ok) throw new Error(`MLB team hitting-by-date-range-vs-hand fetch failed: ${res.status}`);
  return res.json();
}

// Player-level byDateRange (no hand split) IS correctly date-scoped — used to backtest a batter's
// AVG/PA-per-game and HR rate as they stood on a past date, instead of their live season-to-date stats.
export async function fetchBatterHittingByDateRange(personId, season, startDate, endDate) {
  const res = await fetch(`${MLB_API}/people/${personId}/stats?stats=byDateRange&group=hitting&season=${season}&startDate=${startDate}&endDate=${endDate}`);
  if (!res.ok) throw new Error(`MLB batter hitting-by-date-range fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchPlayByPlay(gamePk) {
  const res = await fetch(`${MLB_API}/game/${gamePk}/playByPlay`);
  if (!res.ok) throw new Error(`MLB play-by-play fetch failed: ${res.status}`);
  return res.json();
}

const NOTABLE_HITTING_EVENTS = new Set(['Single', 'Double', 'Triple', 'Home Run']);

// Pulls out every batter/pitcher plate-appearance result from a play-by-play response, for
// post-mortem miss analysis (not used in any live projection). Each entry carries both players'
// handedness for that at-bat, so a miss can be cross-referenced against "was this batter already
// expected to be dangerous against that hand".
export function extractPlateAppearances(playByPlayResponse) {
  const plays = playByPlayResponse.allPlays || [];
  return plays
    .filter(p => p.result?.type === 'atBat' && p.matchup?.batter && p.matchup?.pitcher)
    .map(p => ({
      inning: p.about?.inning ?? null,
      halfInning: p.about?.halfInning ?? null,
      event: p.result?.event ?? null,
      description: p.result?.description ?? null,
      rbi: Number(p.result?.rbi || 0),
      batterId: p.matchup.batter.id,
      batterName: p.matchup.batter.fullName,
      batSide: p.matchup.batSide?.code ?? null,
      pitcherId: p.matchup.pitcher.id,
      pitcherName: p.matchup.pitcher.fullName,
      pitchHand: p.matchup.pitchHand?.code ?? null,
    }));
}

export function extractNotableHits(plateAppearances) {
  return plateAppearances.filter(pa => NOTABLE_HITTING_EVENTS.has(pa.event));
}

export function computeRecentStrikeoutsPer9(gameLogResponse, lastN = 5) {
  const splits = gameLogResponse.stats?.[0]?.splits || [];
  const sorted = [...splits].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const recent = sorted.slice(0, lastN);
  if (recent.length === 0) return LEAGUE_AVG_K_PER_9;
  const strikeOuts = recent.reduce((sum, s) => sum + Number(s.stat.strikeOuts || 0), 0);
  const outs = recent.reduce((sum, s) => sum + inningsPitchedToOuts(s.stat.inningsPitched || '0.0'), 0);
  const inningsPitched = outs / 3;
  if (inningsPitched === 0) return LEAGUE_AVG_K_PER_9;
  return (strikeOuts * 9) / inningsPitched;
}

const LEAGUE_AVG_STRIKEOUT_RATE = 0.223;

export async function fetchTeamHittingVsHand(teamId, hand, season) {
  const sitCode = hand === 'L' ? 'vl' : 'vr';
  const res = await fetch(`${MLB_API}/teams/${teamId}/stats?stats=statSplits&group=hitting&sitCodes=${sitCode}&season=${season}`);
  if (!res.ok) throw new Error(`MLB team hitting-vs-hand fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchBatterHittingVsHand(personId, hand, season) {
  const sitCode = hand === 'L' ? 'vl' : 'vr';
  const res = await fetch(`${MLB_API}/people/${personId}/stats?stats=statSplits&group=hitting&sitCodes=${sitCode}&season=${season}`);
  if (!res.ok) throw new Error(`MLB batter hitting-vs-hand fetch failed: ${res.status}`);
  return res.json();
}

// Used for both team-level and player-level statSplits hitting responses, since they share an identical schema.
export function extractTeamStrikeoutRate(teamHittingStatsResponse) {
  const split = teamHittingStatsResponse.stats?.[0]?.splits?.[0];
  if (!split) return LEAGUE_AVG_STRIKEOUT_RATE;
  const stat = split.stat;
  const strikeOuts = Number(stat.strikeOuts || 0);
  const plateAppearances = Number(stat.plateAppearances || 0);
  if (plateAppearances === 0) return LEAGUE_AVG_STRIKEOUT_RATE;
  return strikeOuts / plateAppearances;
}

export function computeAverageStrikeoutRate(rates) {
  const valid = rates.filter(r => typeof r === 'number' && !Number.isNaN(r));
  if (valid.length === 0) return LEAGUE_AVG_STRIKEOUT_RATE;
  return valid.reduce((sum, r) => sum + r, 0) / valid.length;
}

export async function fetchGameLinescore(gamePk) {
  const res = await fetch(`${MLB_API}/game/${gamePk}/linescore`);
  if (!res.ok) throw new Error(`MLB linescore fetch failed: ${res.status}`);
  return res.json();
}

export function extractFinalScore(linescoreResponse) {
  const home = linescoreResponse.teams?.home?.runs;
  const away = linescoreResponse.teams?.away?.runs;
  if (home == null || away == null) return null;
  return { home: Number(home), away: Number(away) };
}

export async function fetchGameBoxscore(gamePk) {
  const res = await fetch(`${MLB_API}/game/${gamePk}/boxscore`);
  if (!res.ok) throw new Error(`MLB boxscore fetch failed: ${res.status}`);
  return res.json();
}

function findPlayerInBoxscore(boxscoreResponse, personId) {
  for (const side of ['home', 'away']) {
    const players = boxscoreResponse.teams?.[side]?.players || {};
    for (const key of Object.keys(players)) {
      if (players[key].person?.id === personId) return players[key];
    }
  }
  return null;
}

export function extractPlayerBattingHits(boxscoreResponse, personId) {
  const player = findPlayerInBoxscore(boxscoreResponse, personId);
  const hits = player?.stats?.batting?.hits;
  return hits == null ? null : Number(hits);
}

export function extractPlayerPitchingStrikeouts(boxscoreResponse, personId) {
  const player = findPlayerInBoxscore(boxscoreResponse, personId);
  const strikeOuts = player?.stats?.pitching?.strikeOuts;
  return strikeOuts == null ? null : Number(strikeOuts);
}

const LEAGUE_AVG_RUNS_PER_GAME_FALLBACK = 4.5;

export async function fetchTeamSeasonHitting(teamId, season) {
  const res = await fetch(`${MLB_API}/teams/${teamId}/stats?stats=season&group=hitting&season=${season}`);
  if (!res.ok) throw new Error(`MLB team season hitting fetch failed: ${res.status}`);
  return res.json();
}

export function extractRunsPerGame(teamHittingSeasonResponse) {
  const split = teamHittingSeasonResponse.stats?.[0]?.splits?.[0];
  if (!split) return LEAGUE_AVG_RUNS_PER_GAME_FALLBACK;
  const stat = split.stat;
  const runs = Number(stat.runs || 0);
  const gamesPlayed = Number(stat.gamesPlayed || 0);
  if (gamesPlayed === 0) return LEAGUE_AVG_RUNS_PER_GAME_FALLBACK;
  return runs / gamesPlayed;
}

export async function fetchTeamRecentHitting(teamId, season, startDate, endDate) {
  const res = await fetch(`${MLB_API}/teams/${teamId}/stats?stats=byDateRange&group=hitting&startDate=${startDate}&endDate=${endDate}&season=${season}`);
  if (!res.ok) throw new Error(`MLB team recent hitting fetch failed: ${res.status}`);
  return res.json();
}

const LEAGUE_AVG_OPS_FALLBACK = 0.720;

// Used for both team-level and player-level "vs pitcher hand" hitting responses, since they share an identical schema.
export function extractOpsFromHittingStats(hittingStatsResponse) {
  const split = hittingStatsResponse.stats?.[0]?.splits?.[0];
  if (!split) return LEAGUE_AVG_OPS_FALLBACK;
  const ops = Number(split.stat?.ops);
  return Number.isFinite(ops) ? ops : LEAGUE_AVG_OPS_FALLBACK;
}

export async function fetchTeamRecentSchedule(teamId, startDate, endDate) {
  const res = await fetch(`${MLB_API}/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}`);
  if (!res.ok) throw new Error(`MLB team schedule fetch failed: ${res.status}`);
  return res.json();
}

export function findMostRecentFinalGamePk(scheduleResponse) {
  let latest = null;
  for (const d of scheduleResponse.dates || []) {
    for (const g of d.games || []) {
      if (g.status?.detailedState === 'Final') {
        if (!latest || d.date > latest.date) {
          latest = { date: d.date, gamePk: g.gamePk };
        }
      }
    }
  }
  return latest ? latest.gamePk : null;
}

const GAME_FEED_API = 'https://statsapi.mlb.com/api/v1.1';
const LEAGUE_AVG_HR_RATE_FALLBACK = 0.032;
const LEAGUE_AVG_AVG_FALLBACK = 0.248;

export async function fetchGameFeed(gamePk) {
  const res = await fetch(`${GAME_FEED_API}/game/${gamePk}/feed/live`);
  if (!res.ok) throw new Error(`MLB game feed fetch failed: ${res.status}`);
  return res.json();
}

// Weather is only reliably populated by MLB's feed close to game time; returns null fields otherwise.
export function extractWeather(gameFeedResponse) {
  const weather = gameFeedResponse.gameData?.weather;
  if (!weather) return { tempF: null, windMph: 0, windDirection: '', condition: null };
  const tempF = Number(weather.temp);
  const windMatch = String(weather.wind || '').match(/(\d+)\s*mph(?:,\s*(.+))?/i);
  return {
    tempF: Number.isFinite(tempF) ? tempF : null,
    windMph: windMatch ? Number(windMatch[1]) : 0,
    windDirection: windMatch && windMatch[2] ? windMatch[2] : '',
    condition: weather.condition || null,
  };
}

// Used for both team-level and player-level statSplits/season hitting responses (same schema),
// to classify a batter/lineup as power-heavy (high HR rate) vs. contact-heavy (high AVG, low HR rate).
export function extractPowerContactProfile(hittingStatsResponse) {
  const split = hittingStatsResponse.stats?.[0]?.splits?.[0];
  if (!split) return { hrRate: LEAGUE_AVG_HR_RATE_FALLBACK, avg: LEAGUE_AVG_AVG_FALLBACK };
  const stat = split.stat;
  const homeRuns = Number(stat.homeRuns || 0);
  const plateAppearances = Number(stat.plateAppearances || 0);
  const avgNumber = Number(stat.avg);
  const avg = Number.isFinite(avgNumber) ? avgNumber : LEAGUE_AVG_AVG_FALLBACK;
  const hrRate = plateAppearances === 0 ? LEAGUE_AVG_HR_RATE_FALLBACK : homeRuns / plateAppearances;
  return { hrRate, avg };
}

export function extractStartingLineup(boxscoreResponse, teamId) {
  const homeTeam = boxscoreResponse.teams?.home;
  const awayTeam = boxscoreResponse.teams?.away;
  const side = homeTeam?.team?.id === teamId ? homeTeam : awayTeam?.team?.id === teamId ? awayTeam : null;
  if (!side || !Array.isArray(side.battingOrder)) return [];
  return side.battingOrder
    .map(personId => {
      const player = side.players?.[`ID${personId}`];
      return player ? { personId, fullName: player.person.fullName } : null;
    })
    .filter(Boolean);
}
