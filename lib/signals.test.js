import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, pitcherFactor, teamWinProbability, log5 } from './signals.js';
import { moneylineEstimate, projectedTotalRuns, normalCdf, overProbability } from './signals.js';
import { poissonPmf, poissonCdf, overProbabilityProp } from './signals.js';
import { impliedProbability, edge, isSignal, formatSignalMessage } from './signals.js';
import { expectedPitcherStrikeouts } from './signals.js';
import { gradeMoneylineSignal, gradeTotalsSignal, gradeOverSignal } from './signals.js';
import { blendEraEstimates } from './signals.js';

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

test('projectedTotalRuns: a team facing a weak opposing pitcher scores more than one facing a strong one', () => {
  const totalWithWeakAwayPitcher = projectedTotalRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 6.00 }, // away pitcher is bad -> home should score MORE
  });
  const totalWithStrongAwayPitcher = projectedTotalRuns({
    home: { runsPerGame: 4.5, startingPitcherEra: 4.00 },
    away: { runsPerGame: 4.5, startingPitcherEra: 2.00 }, // away pitcher is great -> home should score LESS
  });
  assert.ok(totalWithWeakAwayPitcher > totalWithStrongAwayPitcher);
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

test('poissonPmf: P(0 events | lambda=0) is 1', () => {
  assert.equal(poissonPmf(0, 0.0001) > 0.99, true);
});

test('poissonCdf: cumulative probability approaches 1 as k grows', () => {
  assert.ok(poissonCdf(20, 1.2) > 0.999);
});

test('overProbabilityProp: low expected rate against a low line still allows some over probability', () => {
  const p = overProbabilityProp(1.5, 1.2);
  assert.ok(p > 0 && p < 1);
});

test('overProbabilityProp: higher expected rate raises the over probability for the same line', () => {
  const low = overProbabilityProp(1.5, 0.8);
  const high = overProbabilityProp(1.5, 2.0);
  assert.ok(high > low);
});

test('impliedProbability: decimal odds of 2.00 implies 50%', () => {
  assert.ok(Math.abs(impliedProbability(2.00) - 0.5) < 1e-9);
});

test('edge: estimated minus implied', () => {
  assert.ok(Math.abs(edge(0.60, 0.50) - 0.10) < 1e-9);
});

test('isSignal: edge above threshold is a signal', () => {
  assert.equal(isSignal(0.613, 0.541, 0.05), true);
});

test('isSignal: edge below threshold is not a signal', () => {
  assert.equal(isSignal(0.55, 0.541, 0.05), false);
});

test('formatSignalMessage: includes matchup, market, odds, edge, and reasoning', () => {
  const msg = formatSignalMessage({
    matchup: 'NYY @ BOS',
    market: 'Moneyline',
    selection: 'BOS gana',
    price: 1.85,
    impliedProb: 0.541,
    estimatedProb: 0.613,
    edgeValue: 0.072,
    reasoning: 'ERA abridor BOS 2.87 (últimos 5) vs NYY.',
  });
  assert.match(msg, /NYY @ BOS/);
  assert.match(msg, /Moneyline: BOS gana/);
  assert.match(msg, /1\.85/);
  assert.match(msg, /54\.1%/);
  assert.match(msg, /61\.3%/);
  assert.match(msg, /\+7\.2%/);
  assert.match(msg, /ERA abridor BOS 2\.87/);
});

test('formatSignalMessage: a negative edge does not get a stray plus sign', () => {
  const msg = formatSignalMessage({
    matchup: 'NYY @ BOS',
    market: 'Moneyline',
    selection: 'NYY gana',
    price: 2.10,
    impliedProb: 0.476,
    estimatedProb: 0.40,
    edgeValue: -0.076,
    reasoning: 'Test reasoning.',
  });
  assert.match(msg, /Edge: -7\.6%/);
  assert.doesNotMatch(msg, /Edge: \+-/);
});

test('expectedPitcherStrikeouts: average pitcher facing an average-strikeout team gives a plausible baseline rate', () => {
  const expected = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 0.223 });
  // matchupFactor = 1 (exactly league average) -> (9/9) * 5.5 * 1 = 5.5
  assert.ok(Math.abs(expected - 5.5) < 0.01);
});

test('expectedPitcherStrikeouts: a high-strikeout pitcher projects more Ks than a low-strikeout pitcher, all else equal', () => {
  const aceExpected = expectedPitcherStrikeouts({ pitcherK9: 12.0, teamStrikeoutRate: 0.223 });
  const controlPitcherExpected = expectedPitcherStrikeouts({ pitcherK9: 6.0, teamStrikeoutRate: 0.223 });
  assert.ok(aceExpected > controlPitcherExpected);
});

test('expectedPitcherStrikeouts: facing a strikeout-prone team raises the projection', () => {
  const vsHighKTeam = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 0.30 });
  const vsLowKTeam = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 0.15 });
  assert.ok(vsHighKTeam > vsLowKTeam);
});

test('expectedPitcherStrikeouts: matchup factor is capped so an extreme team K rate does not produce an absurd projection', () => {
  const extreme = expectedPitcherStrikeouts({ pitcherK9: 9.0, teamStrikeoutRate: 5.0 });
  const cappedFactorExpected = (9.0 / 9) * 5.5 * 1.8; // matchupFactor clamped at 1.8
  assert.ok(Math.abs(extreme - cappedFactorExpected) < 0.01);
});

test('gradeMoneylineSignal: hit when the picked home team actually won', () => {
  const hit = gradeMoneylineSignal({ selection: 'Boston Red Sox', homeTeam: 'Boston Red Sox', homeScore: 5, awayScore: 3 });
  assert.equal(hit, true);
});

test('gradeMoneylineSignal: miss when the picked home team actually lost', () => {
  const hit = gradeMoneylineSignal({ selection: 'Boston Red Sox', homeTeam: 'Boston Red Sox', homeScore: 2, awayScore: 5 });
  assert.equal(hit, false);
});

test('gradeMoneylineSignal: hit when the picked away team actually won', () => {
  const hit = gradeMoneylineSignal({ selection: 'New York Yankees', homeTeam: 'Boston Red Sox', homeScore: 2, awayScore: 5 });
  assert.equal(hit, true);
});

test('gradeMoneylineSignal: miss when the picked away team actually lost', () => {
  const hit = gradeMoneylineSignal({ selection: 'New York Yankees', homeTeam: 'Boston Red Sox', homeScore: 5, awayScore: 2 });
  assert.equal(hit, false);
});

test('gradeTotalsSignal: Over hits when actual total exceeds the line', () => {
  const hit = gradeTotalsSignal({ selection: 'Over 8.5', line: 8.5, homeScore: 5, awayScore: 6 });
  assert.equal(hit, true);
});

test('gradeTotalsSignal: Over misses when actual total is below the line', () => {
  const hit = gradeTotalsSignal({ selection: 'Over 8.5', line: 8.5, homeScore: 3, awayScore: 2 });
  assert.equal(hit, false);
});

test('gradeTotalsSignal: Under hits when actual total is below the line', () => {
  const hit = gradeTotalsSignal({ selection: 'Under 8.5', line: 8.5, homeScore: 3, awayScore: 2 });
  assert.equal(hit, true);
});

test('gradeTotalsSignal: Under misses when actual total exceeds the line', () => {
  const hit = gradeTotalsSignal({ selection: 'Under 8.5', line: 8.5, homeScore: 5, awayScore: 6 });
  assert.equal(hit, false);
});

test('gradeOverSignal: hits when actual value exceeds the line', () => {
  const hit = gradeOverSignal({ line: 1.5, actualValue: 2 });
  assert.equal(hit, true);
});

test('gradeOverSignal: misses when actual value is below the line', () => {
  const hit = gradeOverSignal({ line: 1.5, actualValue: 1 });
  assert.equal(hit, false);
});

test('gradeTotalsSignal: returns null (cannot grade) when line is missing', () => {
  const result = gradeTotalsSignal({ selection: 'Over 8.5', line: null, homeScore: 5, awayScore: 2 });
  assert.equal(result, null);
});

test('gradeTotalsSignal: returns null (cannot grade) when line is not a finite number', () => {
  const result = gradeTotalsSignal({ selection: 'Over 8.5', line: NaN, homeScore: 5, awayScore: 2 });
  assert.equal(result, null);
});

test('gradeOverSignal: returns null (cannot grade) when line is missing', () => {
  const result = gradeOverSignal({ line: null, actualValue: 2 });
  assert.equal(result, null);
});

test('gradeOverSignal: returns null (cannot grade) when line is not a finite number', () => {
  const result = gradeOverSignal({ line: undefined, actualValue: 2 });
  assert.equal(result, null);
});

test('blendEraEstimates: weights recent form more heavily than season by default', () => {
  const blended = blendEraEstimates(3.00, 5.00);
  // 3.00*0.6 + 5.00*0.4 = 3.80
  assert.ok(Math.abs(blended - 3.80) < 1e-9);
});

test('blendEraEstimates: equal ERAs blend to the same value regardless of weight', () => {
  const blended = blendEraEstimates(4.00, 4.00);
  assert.ok(Math.abs(blended - 4.00) < 1e-9);
});

test('blendEraEstimates: custom weight is respected', () => {
  const blended = blendEraEstimates(3.00, 5.00, 0.5);
  assert.ok(Math.abs(blended - 4.00) < 1e-9);
});
