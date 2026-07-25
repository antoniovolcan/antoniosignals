// api/backtest-data.js
import { createDbClient, getBacktestRuns, getBacktestPredictions } from '../lib/db.js';
import { summarizePredictions } from '../lib/backtestMetrics.js';

export default async function handler(req, res) {
  if (req.query?.secret !== process.env.DASHBOARD_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const db = createDbClient();
  const action = req.query?.action || 'runs';

  try {
    if (action === 'runs') {
      const runs = await getBacktestRuns(db, 50);
      res.status(200).json({ runs });
      return;
    }

    if (action === 'summary') {
      const runId = req.query.runId;
      if (!runId) { res.status(400).json({ error: 'runId is required' }); return; }
      const predictions = await getBacktestPredictions(db, { runId });
      res.status(200).json(summarizePredictions(predictions));
      return;
    }

    if (action === 'detail') {
      const { runId, date } = req.query;
      if (!runId || !date) { res.status(400).json({ error: 'runId and date are required' }); return; }
      const predictions = await getBacktestPredictions(db, { runId, fromDate: date, toDate: date });
      res.status(200).json({ predictions });
      return;
    }

    res.status(400).json({ error: `unknown action "${action}"` });
  } catch (err) {
    console.error('backtest-data.js error:', err);
    res.status(500).json({ error: err.message });
  }
}
