// api/backtest-analyze.js
import { createDbClient, getBacktestPredictionById } from '../lib/db.js';
import { analyzeMiss } from '../lib/missAnalysis.js';

export default async function handler(req, res) {
  if (req.query?.secret !== process.env.DASHBOARD_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const { predictionId } = req.query;
  if (!predictionId) {
    res.status(400).json({ error: 'predictionId is required' });
    return;
  }

  try {
    const db = createDbClient();
    const prediction = await getBacktestPredictionById(db, predictionId);
    if (!prediction) {
      res.status(404).json({ error: 'prediction not found' });
      return;
    }
    const analysis = await analyzeMiss(prediction);
    res.status(200).json(analysis);
  } catch (err) {
    console.error('backtest-analyze.js error:', err);
    res.status(500).json({ error: err.message });
  }
}
