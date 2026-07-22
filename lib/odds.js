// lib/odds.js
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

// Picks the first bookmaker in the response that offers this market (no best-price/consensus logic in v1).
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

// Returns outcomes from the first bookmaker offering this market for this player (no cross-book aggregation in v1).
export function parsePlayerPropOutcomes(eventOddsResponse, marketKey, playerName) {
  for (const bookmaker of eventOddsResponse.bookmakers || []) {
    const market = bookmaker.markets.find(m => m.key === marketKey);
    if (!market) continue;
    const outcomes = market.outcomes.filter(o => o.description === playerName);
    if (outcomes.length) return outcomes;
  }
  return [];
}

export async function fetchEventPlayerProps(apiKey, eventId, marketsCsv) {
  const res = await fetch(`${ODDS_API_BASE}/sports/baseball_mlb/events/${eventId}/odds?apiKey=${apiKey}&regions=us&markets=${marketsCsv}&oddsFormat=decimal`);
  if (!res.ok) throw new Error(`Odds API player props fetch failed: ${res.status}`);
  return res.json();
}
