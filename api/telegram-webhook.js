// api/telegram-webhook.js
import { createDbClient } from '../lib/db.js';
import { fetchSchedule, parseScheduleGames } from '../lib/mlb.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { runScan } from './scan.js';

const STATUS_LABEL = { scheduled: 'Programado', live: 'En vivo', final: 'Terminado', postponed: 'Pospuesto' };

export default async function handler(req, res) {
  const update = req.body;
  const text = update?.message?.text?.trim() || '';
  const chatId = update?.message?.chat?.id;
  if (!chatId || String(chatId) !== process.env.TELEGRAM_CHAT_ID) {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    if (text === '/hoy') {
      const today = new Date().toISOString().slice(0, 10);
      const games = parseScheduleGames(await fetchSchedule(today));
      const lines = games.map(g => `${g.awayTeam} @ ${g.homeTeam} — ${STATUS_LABEL[g.status]}`);
      const reply = lines.length ? lines.join('\n') : 'No hay juegos de MLB hoy.';
      await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, reply);
    } else if (text === '/senales') {
      const result = await runScan();
      await sendTelegramMessage(
        process.env.TELEGRAM_BOT_TOKEN,
        chatId,
        result.signalsSent > 0 ? `Se enviaron ${result.signalsSent} señales nuevas.` : 'No se encontraron señales con edge suficiente ahora mismo.'
      );
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('telegram-webhook.js error:', err);
    res.status(200).json({ ok: true }); // always 200 to Telegram, log the error server-side
  }
}
