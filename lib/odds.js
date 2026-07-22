// lib/odds.js
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

function extractMarket(event, marketKey) {
  for (const bookmaker of event.bookmakers || []) {
    const market = bookmaker.markets.find(m => m.key === marketKey);
    if (market) return { bookmaker: bookmaker.key, outcomes: market.outcomes };
  }
  return null;
}

export function parseOddsEvents(oddsResponse) {
  return oddsResponse.map(event => ({
    id: event.id,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    commenceTime: event.commence_time,
    h2h: extractMarket(event, 'h2h'),
    totals: extractMarket(event, 'totals'),
  }));
}

export function findTeamPrice(h2hMarket, teamName) {
  if (!h2hMarket) return null;
  const outcome = h2hMarket.outcomes.find(o => o.name === teamName);
  return outcome ? outcome.price : null;
}

export function findTotalsLine(totalsMarket, side) {
  if (!totalsMarket) return null;
  const outcome = totalsMarket.outcomes.find(o => o.name === side);
  return outcome ? { price: outcome.price, point: outcome.point } : null;
}

export async function fetchMlbOdds(apiKey) {
  const res = await fetch(`${ODDS_API_BASE}/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=h2h,totals&oddsFormat=decimal`);
  if (!res.ok) throw new Error(`Odds API fetch failed: ${res.status}`);
  return res.json();
}
