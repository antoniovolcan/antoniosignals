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
