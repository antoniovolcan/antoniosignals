import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSimPrediction } from './db.js';

function makeDb({ data = null, error = null, throwOnQuery = false } = {}) {
  const query = {
    eq() { return this; },
    async maybeSingle() {
      if (throwOnQuery) throw new Error('network is down');
      return { data, error };
    },
  };
  return {
    from() {
      return { select() { return query; } };
    },
  };
}

test('getSimPrediction: returns mapped prediction when a row exists', async () => {
  const db = makeDb({
    data: { home_team: 'New York Yankees', away_team: 'Boston Red Sox', home_win_pct: 0.62, away_win_pct: 0.38 },
  });
  const result = await getSimPrediction(db, '2026-07-29', 'New York Yankees', 'Boston Red Sox');
  assert.deepEqual(result, {
    homeTeam: 'New York Yankees', awayTeam: 'Boston Red Sox', homeWinPct: 0.62, awayWinPct: 0.38,
  });
});

test('getSimPrediction: resolves to null (does not throw) when the query returns an error', async () => {
  const db = makeDb({ error: new Error('table does not exist') });
  const result = await getSimPrediction(db, '2026-07-29', 'New York Yankees', 'Boston Red Sox');
  assert.equal(result, null);
});

test('getSimPrediction: resolves to null (does not throw) when the query itself throws', async () => {
  const db = makeDb({ throwOnQuery: true });
  const result = await getSimPrediction(db, '2026-07-29', 'New York Yankees', 'Boston Red Sox');
  assert.equal(result, null);
});
