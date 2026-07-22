import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, pitcherFactor, teamWinProbability, log5 } from './signals.js';
import { moneylineEstimate, projectedTotalRuns, normalCdf, overProbability } from './signals.js';

test('clamp bounds a value', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(20, 0, 10), 10);
});

test('pitcherFactor: league-average ERA gives factor 1', () => {
  assert.equal(pitcherFactor(4.00, 4.00), 1);
});

test('pitcherFactor: elite ERA gives factor above 1, capped at 1.8', () => {
  assert.ok(pitcherFactor(1.50, 4.00) > 1);
  assert.equal(pitcherFactor(0.10, 4.00), 1.8);
});

test('pitcherFactor: poor ERA gives factor below 1, floored at 0.5', () => {
  assert.ok(pitcherFactor(8.00, 4.00) < 1);
  assert.equal(pitcherFactor(100, 4.00), 0.5);
});

test('teamWinProbability: league-average team at home is above .500', () => {
  const p = teamWinProbability({ last10WinPct: 0.5, startingPitcherEra: 4.00, isHome: true });
  assert.ok(p > 0.5);
});

test('teamWinProbability: league-average team on the road is below .500', () => {
  const p = teamWinProbability({ last10WinPct: 0.5, startingPitcherEra: 4.00, isHome: false });
  assert.ok(p < 0.5);
});

test('log5: two evenly matched .500 teams gives 50%', () => {
  assert.ok(Math.abs(log5(0.5, 0.5) - 0.5) < 1e-9);
});

test('log5: stronger team has higher win probability', () => {
  assert.ok(log5(0.65, 0.45) > 0.5);
});

test('moneylineEstimate: home favorite with better pitcher wins more often', () => {
  const p = moneylineEstimate({
    home: { last10WinPct: 0.7, startingPitcherEra: 2.80 },
    away: { last10WinPct: 0.4, startingPitcherEra: 4.80 },
  });
  assert.ok(p > 0.5);
});

test('projectedTotalRuns: two average teams/pitchers project near league average total', () => {
  const total = projectedTotalRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
  });
  assert.ok(Math.abs(total - 9.0) < 0.5);
});

test('normalCdf: at the mean returns 0.5', () => {
  assert.ok(Math.abs(normalCdf(9.0, 9.0, 3.0) - 0.5) < 0.01);
});

test('normalCdf: far below the mean returns near 0', () => {
  assert.ok(normalCdf(0, 9.0, 3.0) < 0.01);
});

test('normalCdf: far above the mean returns near 1', () => {
  assert.ok(normalCdf(30, 9.0, 3.0) > 0.99);
});

test('overProbability: line below projection favors the over', () => {
  const p = overProbability(7.5, 9.0, 3.0);
  assert.ok(p > 0.5);
});

test('overProbability: line above projection favors the under', () => {
  const p = overProbability(11.5, 9.0, 3.0);
  assert.ok(p < 0.5);
});
