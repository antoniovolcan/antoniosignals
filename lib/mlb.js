// lib/mlb.js
const MLB_API = 'https://statsapi.mlb.com/api/v1';

// MLB's "game day" runs on US Eastern time, not UTC. Every place in this
// codebase that means "today's/yesterday's slate of games" (schedule
// fetching, signal dedup windows, nightly grading, the sim-prediction
// cross-check) must agree on the same calendar day, or they silently
// desync for several hours every evening -- confirmed live: UTC rolls to
// the next calendar day at 8pm Eastern (EDT), right when most MLB games
// are in progress, while a UTC-based "today" would already point at
// tomorrow's schedule.
export function mlbDateToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// Pure calendar-day arithmetic on a YYYY-MM-DD string -- no timezone
// conversion needed here, since we're just counting whole days from an
// already-correct Eastern calendar date (e.g. mlbDateToday()).
export function addDaysToDateString(dateString, days) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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
  const res = await fetch(`${MLB_API}/schedule?sportId=1&date=${date}&gameType=R&hydrate=probablePitcher`);
  if (!res.ok) throw new Error(`MLB schedule fetch failed: ${res.status}`);
  return res.json();
}

const LEAGUE_AVG_ERA_FALLBACK = 4.00;

// Matches the 0.4x-2.2x-league-average ratio clamp already applied downstream (projectedTotalRuns,
// pitcherFactor) — but those only clamp a RATIO derived from this
// value, never this raw value itself. A pitcher with 1-2 starts recorded (e.g. first week of a new
// season) can have earnedRuns*9/inningsPitched blow up to something like 65 from a single bad
// outing — the downstream ratio clamps kept actual projections/probabilities sane (confirmed: no
// moneyline probability in a full-season backtest ever approached its clamp bounds), but this raw
// value is also stored in backtest_predictions.factors and shown directly in live Telegram
// reasoning text ("ERA de temporada 65.74"), where it looked broken even though the bet decision
// underneath it wasn't. Clamping at the source fixes the display/storage while being a no-op for
// every existing downstream ratio clamp (any value already outside this range was already being
// truncated to the same effective bound by those, just later in the pipeline).
const MIN_REALISTIC_ERA = LEAGUE_AVG_ERA_FALLBACK * 0.4;
const MAX_REALISTIC_ERA = LEAGUE_AVG_ERA_FALLBACK * 2.2;

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
  return clamp((earnedRuns * 9) / inningsPitched, MIN_REALISTIC_ERA, MAX_REALISTIC_ERA);
}

export function computeSeasonEra(gameLogResponse) {
  return computeRecentEra(gameLogResponse, Infinity);
}

export function extractPitcherName(gameLogResponse) {
  const splits = gameLogResponse.stats?.[0]?.splits || [];
  return splits[0]?.player?.fullName || null;
}

// How many real starts (gamesStarted===1 appearances, excludes relief outings) are behind a
// pitcher's season/recent ERA in this gameLog. Used to dampen moneyline confidence when the
// favored pitcher's rating rests on a thin sample — see THIN_SAMPLE_STARTS_THRESHOLD in signals.js.
export function countRealStarts(gameLogResponse) {
  const splits = gameLogResponse.stats?.[0]?.splits || [];
  return splits.filter(s => Number(s.stat?.gamesStarted || 0) === 1).length;
}

export async function fetchPitcherGameLog(personId, season) {
  const res = await fetch(`${MLB_API}/people/${personId}/stats?stats=gameLog&group=pitching&season=${season}`);
  if (!res.ok) throw new Error(`MLB pitcher gamelog fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchPitcherYearByYearStats(personId) {
  const res = await fetch(`${MLB_API}/people/${personId}/stats?stats=yearByYear&group=pitching`);
  if (!res.ok) throw new Error(`MLB pitcher year-by-year stats fetch failed: ${res.status}`);
  return res.json();
}

// A pitcher traded mid-season gets one split per team PLUS a combined split with no `team`
// field carrying that season's real total (verified against the live API: Scherzer's 2021 has
// Washington 111.0 IP + Dodgers 68.1 IP + a combined 179.1 IP split). Summing every split for a
// season with a trade would double/triple-count it, so for each season we keep only the
// combined split when one exists, and the single split otherwise.
function dedupSeasonSplits(splits) {
  const bySeason = new Map();
  for (const split of splits) {
    const season = split.season;
    const existing = bySeason.get(season);
    if (!existing || !split.team) {
      bySeason.set(season, split);
    }
  }
  return [...bySeason.values()];
}

function priorRegularSeasonSplits(yearByYearResponse, beforeSeason) {
  const splits = yearByYearResponse.stats?.[0]?.splits || [];
  const regularSeason = splits.filter(s => s.gameType === 'R' && Number(s.season) < beforeSeason);
  return dedupSeasonSplits(regularSeason);
}

// Career = every regular season strictly before beforeSeason (never the season under analysis
// itself), so this is identical whether called live (beforeSeason = current year) or from the
// backtest (beforeSeason = the season being tested) — those prior seasons are equally "closed"
// either way, unlike recent-form data which needs date-scoping to stay leak-free.
export function computeCareerEraBeforeSeason(yearByYearResponse, beforeSeason) {
  const priorSplits = priorRegularSeasonSplits(yearByYearResponse, beforeSeason);
  if (priorSplits.length === 0) return null;
  const earnedRuns = priorSplits.reduce((sum, s) => sum + Number(s.stat.earnedRuns || 0), 0);
  const outs = priorSplits.reduce((sum, s) => sum + inningsPitchedToOuts(s.stat.inningsPitched || '0.0'), 0);
  const inningsPitched = outs / 3;
  if (inningsPitched === 0) return null;
  return (earnedRuns * 9) / inningsPitched;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

const MIN_REALISTIC_AVG = 0.150;
const MAX_REALISTIC_AVG = 0.380;

// A batter's AVG over a small date-range window (e.g. right after a callup/return from injury, or
// early in a season) can be a handful of at-bats — enough to swing to .000 or 1.000, neither of
// which is a realistic expectation going forward. Same idea as the ERA clamp in projectedTotalRuns:
// found a real case (avg=1.000 -> projected 5 hits in one game) while auditing backtest predictions.
export function extractBattingAvgAndPA(batterStatsResponse) {
  const split = batterStatsResponse.stats?.[0]?.splits?.[0];
  if (!split) return { avg: 0.240, paPerGame: 4.3 };
  const stat = split.stat;
  const games = Number(stat.gamesPlayed);
  if (!games) return { avg: 0.240, paPerGame: 4.3 };
  const avgNumber = Number(stat.avg);
  const avg = Number.isFinite(avgNumber) ? clamp(avgNumber, MIN_REALISTIC_AVG, MAX_REALISTIC_AVG) : 0.240;
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

// Backtesting-only helper: restricts a full-season gameLog response to splits strictly before
// cutoffDate, so downstream functions (computeRecentEra, computeSeasonEra, extractPitcherName)
// only ever see data that existed at that point in the season — required to backtest without
// leaking future information into the projection.
export function filterGameLogBefore(gameLogResponse, cutoffDate) {
  const splits = gameLogResponse.stats?.[0]?.splits || [];
  return { stats: [{ splits: splits.filter(s => (s.date || '') < cutoffDate) }] };
}

// Computed from a team-schedule response (which already carries each game's final score/winner)
// instead of MLB's live standings endpoint, which only reflects the team's CURRENT record — needed
// to get a team's record as it stood on a past date, live or in the backtest. Pass { lastN: 15 }
// for a recent-form window, or omit it to count every finished game in the schedule response —
// the latter is how "season-to-date win pct" is derived (give it a schedule starting from the
// season opener through the day before the cutoff, and it's the full-season record as of that date).
export function computeWinPctFromSchedule(scheduleResponse, teamId, { lastN } = {}) {
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
  const games = lastN ? finals.slice(0, lastN) : finals;
  if (games.length === 0) return 0.5;
  return games.filter(g => g.isWinner).length / games.length;
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

// Sums runs through the first 5 innings only, for the "first 5 innings" totals market (which mostly
// reflects the two starting pitchers, not the bullpen). Returns null if fewer than 5 innings are on
// record (shouldn't happen for a completed regulation game, but guards against odd/partial data).
export function extractFirstFiveInningsScore(linescoreResponse) {
  const innings = (linescoreResponse.innings || []).filter(i => i.num <= 5);
  if (innings.length < 5) return null;
  const home = innings.reduce((sum, i) => sum + Number(i.home?.runs || 0), 0);
  const away = innings.reduce((sum, i) => sum + Number(i.away?.runs || 0), 0);
  return { home, away };
}

export async function fetchGameBoxscore(gamePk) {
  const res = await fetch(`${MLB_API}/game/${gamePk}/boxscore`);
  if (!res.ok) throw new Error(`MLB boxscore fetch failed: ${res.status}`);
  return res.json();
}

// Sums relief-pitcher outs recorded for one team in a completed game (excludes the starter, i.e.
// any pitcher with gamesStarted === 1) -- used to build a rolling bullpen-fatigue signal from
// games a team has already played, with no forecast/leakage risk since it's all closed history.
export function sumBullpenOutsFromBoxscore(boxscoreResponse, teamId) {
  const side = boxscoreResponse.teams?.home?.team?.id === teamId ? 'home'
    : boxscoreResponse.teams?.away?.team?.id === teamId ? 'away' : null;
  if (!side) return 0;
  const players = boxscoreResponse.teams[side].players || {};
  let outs = 0;
  for (const key of Object.keys(players)) {
    const pitching = players[key].stats?.pitching;
    if (!pitching || pitching.outs == null) continue;
    if (pitching.gamesStarted === 1) continue;
    outs += Number(pitching.outs) || 0;
  }
  return outs;
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

export async function fetchTeamTransactions(teamId, startDate, endDate) {
  const res = await fetch(`${MLB_API}/transactions?teamId=${teamId}&startDate=${startDate}&endDate=${endDate}`);
  if (!res.ok) throw new Error(`MLB transactions fetch failed: ${res.status}`);
  return res.json();
}

const IL_PLACE_RE = /\b(placed|transferred)\b.*\binjured list\b/i;
const IL_RETURN_RE = /\b(activated|reinstated)\b.*\bfrom the .*injured list\b/i;

// Replays a team's transactions in date order to reconstruct who was actively on the injured list
// as of cutoffDate (exclusive -- only transactions strictly before it count, to stay leak-free).
// "Transferred...injured list to...injured list" (e.g. 10-day -> 60-day) still counts as IL, since
// the player remains out; only an explicit activation/reinstatement clears a player's IL flag.
export function computeActiveILCount(transactionsResponse, cutoffDate) {
  const txns = [...(transactionsResponse.transactions || [])]
    .filter(t => t.person?.id && t.date && t.date < cutoffDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const statusByPlayer = new Map();
  for (const t of txns) {
    const desc = t.description || '';
    if (IL_PLACE_RE.test(desc)) statusByPlayer.set(t.person.id, true);
    else if (IL_RETURN_RE.test(desc)) statusByPlayer.set(t.person.id, false);
  }
  let count = 0;
  for (const onIL of statusByPlayer.values()) if (onIL) count++;
  return count;
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
  const res = await fetch(`${MLB_API}/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&gameType=R`);
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

const LEAGUE_AVG_HR_RATE_FALLBACK = 0.032;
const LEAGUE_AVG_AVG_FALLBACK = 0.248;

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
