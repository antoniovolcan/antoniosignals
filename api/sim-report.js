// api/sim-report.js
import { createDbClient, getSimPredictionsForDate } from '../lib/db.js';
import { formatSimReportMessage } from '../lib/signals.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { mlbDateToday } from '../lib/mlb.js';

export async function runSimReport(date = mlbDateToday()) {
  const db = createDbClient();
  const predictions = await getSimPredictionsForDate(db, date);
  const message = formatSimReportMessage(date, predictions);
  await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, message);
  return { date, gamesCount: predictions.length };
}

export default async function handler(req, res) {
  if (req.query?.secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const result = await runSimReport();
    res.status(200).json(result);
  } catch (err) {
    console.error('sim-report.js error:', err);
    res.status(500).json({ error: err.message });
  }
}
