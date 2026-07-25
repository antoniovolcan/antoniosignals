// lib/backtestMetrics.js
// Pure aggregation functions for backtest_predictions rows. No odds/edge/ROI involved —
// these measure raw prediction accuracy: classification quality for moneyline (a real win/loss
// outcome exists), regression quality for the count-based markets (no real betting line to grade
// an over/under against, so bias/MAE/RMSE against the actual value is the honest metric).

export function computeAccuracy(predictions) {
  const valid = predictions.filter(p => typeof p.projectedProb === 'number' && typeof p.actualOutcome === 'boolean');
  if (valid.length === 0) return null;
  const correct = valid.filter(p => (p.projectedProb > 0.5) === p.actualOutcome).length;
  return correct / valid.length;
}

export function computeBrierScore(predictions) {
  const valid = predictions.filter(p => typeof p.projectedProb === 'number' && typeof p.actualOutcome === 'boolean');
  if (valid.length === 0) return null;
  const sum = valid.reduce((s, p) => s + (p.projectedProb - (p.actualOutcome ? 1 : 0)) ** 2, 0);
  return sum / valid.length;
}

export function computeRegressionMetrics(predictions) {
  const valid = predictions.filter(p => typeof p.projectedValue === 'number' && typeof p.actualValue === 'number' && Number.isFinite(p.projectedValue) && Number.isFinite(p.actualValue));
  if (valid.length === 0) return null;
  const errors = valid.map(p => p.actualValue - p.projectedValue);
  const n = errors.length;
  const bias = errors.reduce((s, e) => s + e, 0) / n;
  const mae = errors.reduce((s, e) => s + Math.abs(e), 0) / n;
  const rmse = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / n);
  return { n, bias, mae, rmse };
}

const NUMERIC_MARKETS = ['totals', 'pitcher_strikeouts', 'player_prop'];

// Groups raw backtest_predictions rows (snake_case, as returned by Supabase) by market and by day,
// computing the right metric shape for each market type at both granularities.
export function summarizePredictions(predictions) {
  const byMarket = {};
  const byDay = {};
  for (const p of predictions) {
    (byMarket[p.market] ||= []).push(p);
    const day = (byDay[p.game_date] ||= {});
    (day[p.market] ||= []).push(p);
  }

  function metricsFor(market, rows) {
    if (!rows || rows.length === 0) return null;
    if (market === 'moneyline') {
      const mapped = rows.map(p => ({ projectedProb: p.projected_prob, actualOutcome: p.actual_outcome }));
      return { n: rows.length, accuracy: computeAccuracy(mapped), brier: computeBrierScore(mapped) };
    }
    if (NUMERIC_MARKETS.includes(market)) {
      return computeRegressionMetrics(rows.map(p => ({ projectedValue: p.projected_value, actualValue: p.actual_value })));
    }
    return null;
  }

  const markets = ['moneyline', 'totals', 'pitcher_strikeouts', 'player_prop'];
  const marketSummary = {};
  for (const market of markets) marketSummary[market] = metricsFor(market, byMarket[market]);

  const daily = Object.keys(byDay).sort().map(date => {
    const entry = { date };
    for (const market of markets) entry[market] = metricsFor(market, byDay[date][market]);
    return entry;
  });

  return { marketSummary, daily };
}
