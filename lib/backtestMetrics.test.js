import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAccuracy, computeBrierScore, computeRegressionMetrics, summarizePredictions } from './backtestMetrics.js';

test('computeAccuracy: all correct predictions gives 1.0', () => {
  const acc = computeAccuracy([
    { projectedProb: 0.7, actualOutcome: true },
    { projectedProb: 0.3, actualOutcome: false },
  ]);
  assert.equal(acc, 1.0);
});

test('computeAccuracy: half correct gives 0.5', () => {
  const acc = computeAccuracy([
    { projectedProb: 0.7, actualOutcome: true },
    { projectedProb: 0.7, actualOutcome: false },
  ]);
  assert.equal(acc, 0.5);
});

test('computeAccuracy: returns null when there is nothing gradable', () => {
  assert.equal(computeAccuracy([]), null);
  assert.equal(computeAccuracy([{ projectedProb: 0.7, actualOutcome: null }]), null);
});

test('computeBrierScore: perfect confident predictions give a score of 0', () => {
  const brier = computeBrierScore([
    { projectedProb: 1.0, actualOutcome: true },
    { projectedProb: 0.0, actualOutcome: false },
  ]);
  assert.equal(brier, 0);
});

test('computeBrierScore: confidently wrong predictions give a score near 1', () => {
  const brier = computeBrierScore([
    { projectedProb: 1.0, actualOutcome: false },
  ]);
  assert.equal(brier, 1);
});

test('computeBrierScore: a well-calibrated 50/50 guess gives 0.25', () => {
  const brier = computeBrierScore([
    { projectedProb: 0.5, actualOutcome: true },
    { projectedProb: 0.5, actualOutcome: false },
  ]);
  assert.equal(brier, 0.25);
});

test('computeRegressionMetrics: computes bias, MAE, and RMSE from projected vs actual', () => {
  const metrics = computeRegressionMetrics([
    { projectedValue: 5, actualValue: 7 },  // error +2
    { projectedValue: 5, actualValue: 3 },  // error -2
  ]);
  assert.equal(metrics.n, 2);
  assert.ok(Math.abs(metrics.bias - 0) < 1e-9); // errors cancel out
  assert.ok(Math.abs(metrics.mae - 2) < 1e-9);
  assert.ok(Math.abs(metrics.rmse - 2) < 1e-9);
});

test('computeRegressionMetrics: a systematic overestimate shows up as negative bias', () => {
  const metrics = computeRegressionMetrics([
    { projectedValue: 6, actualValue: 4 },
    { projectedValue: 6, actualValue: 5 },
  ]);
  assert.ok(metrics.bias < 0);
});

test('computeRegressionMetrics: returns null when nothing is gradable', () => {
  assert.equal(computeRegressionMetrics([]), null);
  assert.equal(computeRegressionMetrics([{ projectedValue: null, actualValue: 5 }]), null);
});

test('summarizePredictions: groups by market and by day, computing the right metric shape for each', () => {
  const rows = [
    { market: 'moneyline', game_date: '2026-05-01', projected_prob: 0.7, actual_outcome: true },
    { market: 'totals', game_date: '2026-05-01', projected_value: 8.5, actual_value: 9 },
    { market: 'totals', game_date: '2026-05-02', projected_value: 7.0, actual_value: 6 },
  ];
  const { marketSummary, daily } = summarizePredictions(rows);

  assert.equal(marketSummary.moneyline.n, 1);
  assert.equal(marketSummary.moneyline.accuracy, 1.0);
  assert.equal(marketSummary.totals.n, 2);
  assert.equal(marketSummary.totals_f5, null);

  assert.equal(daily.length, 2);
  assert.equal(daily[0].date, '2026-05-01');
  assert.equal(daily[0].totals.n, 1);
  assert.equal(daily[0].moneyline.n, 1);
  assert.equal(daily[1].date, '2026-05-02');
  assert.equal(daily[1].moneyline, null);
});

test('summarizePredictions: empty input returns null summaries and no daily entries', () => {
  const { marketSummary, daily } = summarizePredictions([]);
  assert.equal(marketSummary.moneyline, null);
  assert.deepEqual(daily, []);
});
