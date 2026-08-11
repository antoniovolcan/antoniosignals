import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTeamLedger, updateTeamLedgerFromGame, getTeamLedgerProfile, pythagoreanWinPct } from './teamLedger.js';

test('pythagoreanWinPct: an even run differential gives 50%', () => {
  assert.ok(Math.abs(pythagoreanWinPct({ runsFor: 100, runsAgainst: 100 }) - 0.5) < 1e-9);
});

test('pythagoreanWinPct: outscoring opponents gives a win% above 50%', () => {
  assert.ok(pythagoreanWinPct({ runsFor: 500, runsAgainst: 400 }) > 0.5);
});

test('pythagoreanWinPct: returns 0.5 (not NaN) when no runs have been scored either way', () => {
  assert.equal(pythagoreanWinPct({ runsFor: 0, runsAgainst: 0 }), 0.5);
});

test('updateTeamLedgerFromGame: records a win for the home team and a loss for the away team', () => {
  const ledger = createTeamLedger();
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 5, awayScore: 3, date: '2025-05-01' });
  const home = getTeamLedgerProfile(ledger, 1);
  const away = getTeamLedgerProfile(ledger, 2);
  assert.equal(home.winPct, 1);
  assert.equal(away.winPct, 0);
  assert.equal(home.runsPerGame, 5);
  assert.equal(home.runsAllowedPerGame, 3);
  assert.equal(away.runsPerGame, 3);
  assert.equal(away.runsAllowedPerGame, 5);
});

test('updateTeamLedgerFromGame: accumulates across multiple games', () => {
  const ledger = createTeamLedger();
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 5, awayScore: 3, date: '2025-05-01' });
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 3, homeScore: 2, awayScore: 6, date: '2025-05-02' });
  const profile = getTeamLedgerProfile(ledger, 1);
  assert.equal(profile.games, 2);
  assert.equal(profile.winPct, 0.5);
  assert.equal(profile.runsPerGame, 3.5); // (5+2)/2
  assert.equal(profile.runsAllowedPerGame, 4.5); // (3+6)/2
});

test('getTeamLedgerProfile: home/away splits are tracked separately from overall', () => {
  const ledger = createTeamLedger();
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 5, awayScore: 3, date: '2025-05-01' }); // team 1 wins at home
  updateTeamLedgerFromGame(ledger, { homeTeamId: 3, awayTeamId: 1, homeScore: 6, awayScore: 2, date: '2025-05-02' }); // team 1 loses on the road
  const profile = getTeamLedgerProfile(ledger, 1);
  assert.equal(profile.homeWinPct, 1);
  assert.equal(profile.awayWinPct, 0);
  assert.equal(profile.winPct, 0.5);
});

test('getTeamLedgerProfile: recent-N window only counts the last N games', () => {
  const ledger = createTeamLedger();
  // 3 losses then 2 wins for team 1
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 1, awayScore: 5, date: '2025-05-01' });
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 1, awayScore: 5, date: '2025-05-02' });
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 1, awayScore: 5, date: '2025-05-03' });
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 5, awayScore: 1, date: '2025-05-04' });
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 5, awayScore: 1, date: '2025-05-05' });
  const overall = getTeamLedgerProfile(ledger, 1);
  assert.equal(overall.winPct, 0.4); // 2/5
  const last2 = getTeamLedgerProfile(ledger, 1, { recentN: 2 });
  assert.equal(last2.recentWinPct, 1); // last 2 games were both wins
  assert.equal(last2.recentGames, 2);
});

test('getTeamLedgerProfile: current streak is positive for a winning streak, negative for a losing streak', () => {
  const ledger = createTeamLedger();
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 5, awayScore: 1, date: '2025-05-01' }); // win
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 5, awayScore: 1, date: '2025-05-02' }); // win
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: 1, awayScore: 5, date: '2025-05-03' }); // loss
  const profile = getTeamLedgerProfile(ledger, 1);
  assert.equal(profile.streak, -1);
});

test('getTeamLedgerProfile: returns null for a team with no games recorded yet', () => {
  const ledger = createTeamLedger();
  assert.equal(getTeamLedgerProfile(ledger, 999), null);
});

test('getTeamLedgerProfile: ignores games with missing/non-numeric scores instead of corrupting the ledger', () => {
  const ledger = createTeamLedger();
  updateTeamLedgerFromGame(ledger, { homeTeamId: 1, awayTeamId: 2, homeScore: null, awayScore: null, date: '2025-05-01' });
  assert.equal(getTeamLedgerProfile(ledger, 1), null);
});
