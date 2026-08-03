// api/telegram-webhook.js
import { createDbClient, setConfigValue } from '../lib/db.js';
import { fetchSchedule, parseScheduleGames, mlbDateToday } from '../lib/mlb.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { runScan, sendAllTodaysSignals } from './scan.js';
import { runSimReport } from './sim-report.js';

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
      const today = mlbDateToday();
      const games = parseScheduleGames(await fetchSchedule(today));
      const lines = games.map(g => `${g.awayTeam} @ ${g.homeTeam} — ${STATUS_LABEL[g.status]}`);
      const reply = lines.length ? lines.join('\n') : 'No hay juegos de MLB hoy.';
      await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, reply);
    } else if (text === '/senales') {
      await runScan({ force: true, sendDigest: false });
      const db = createDbClient();
      const { count } = await sendAllTodaysSignals(db);
      await sendTelegramMessage(
        process.env.TELEGRAM_BOT_TOKEN,
        chatId,
        count > 0 ? `Se mandaron ${count} señales activas de hoy.` : 'No hay señales activas con edge suficiente ahora mismo.'
      );
    } else if (text === '/simulaciones') {
      await runSimReport();
    } else if (text.startsWith('/partido ')) {
      const query = text.slice('/partido '.length).trim().toLowerCase();
      const today = mlbDateToday();
      const games = parseScheduleGames(await fetchSchedule(today));
      const match = games.find(g => g.homeTeam.toLowerCase().includes(query) || g.awayTeam.toLowerCase().includes(query));
      if (!match) {
        await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, `No encontré un juego de hoy para "${query}".`);
      } else {
        await sendTelegramMessage(
          process.env.TELEGRAM_BOT_TOKEN,
          chatId,
          `${match.awayTeam} @ ${match.homeTeam} — ${STATUS_LABEL[match.status]}. Usa /senales para ver el análisis completo del día (incluye este juego si tiene edge suficiente).`
        );
      }
    } else if (text.startsWith('/config edge ')) {
      const value = Number(text.slice('/config edge '.length).trim());
      if (Number.isNaN(value) || value <= 0 || value >= 1) {
        await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, 'Uso: /config edge 0.05 (un número entre 0 y 1, ej. 0.05 = 5%).');
      } else {
        const db = createDbClient();
        await setConfigValue(db, 'edge_threshold', String(value));
        await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, chatId, `Umbral de edge actualizado a ${(value * 100).toFixed(1)}%.`);
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('telegram-webhook.js error:', err);
    try {
      await sendTelegramMessage(
        process.env.TELEGRAM_BOT_TOKEN,
        chatId,
        `⚠️ Hubo un error al procesar ese comando: ${err.message}`
      );
    } catch (notifyErr) {
      console.error('telegram-webhook.js: failed to notify user of error:', notifyErr);
    }
    res.status(200).json({ ok: true }); // always 200 to Telegram, log the error server-side
  }
}
