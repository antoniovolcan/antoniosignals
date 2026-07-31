// api/nightly-report.js
import { createDbClient, getUngradedSignalsForDate, markSignalGraded, upsertGameResult, getGameInfo } from '../lib/db.js';
import { fetchGameLinescore, extractFinalScore, fetchGameBoxscore, extractPlayerBattingHits, extractPlayerPitchingStrikeouts, mlbDateToday, addDaysToDateString } from '../lib/mlb.js';
import { gradeMoneylineSignal, gradeTotalsSignal, gradeOverSignal } from '../lib/signals.js';
import { sendTelegramMessage, sendTelegramDocument } from '../lib/telegram.js';

const MARKET_LABELS = {
  moneyline: 'Moneyline',
  totals: 'Totales',
  player_prop: 'Hits bateador',
  pitcher_strikeouts: 'Ponches pitcher',
};

function yesterdayDateString() {
  return addDaysToDateString(mlbDateToday(), -1);
}

export async function runNightlyReport(date = yesterdayDateString()) {
  const db = createDbClient();
  const signals = await getUngradedSignalsForDate(db, date);

  const gameInfoCache = new Map();
  const finalScoreCache = new Map();
  const boxscoreCache = new Map();
  const persistedResults = new Set();
  const graded = [];

  for (const signal of signals) {
    try {
      if (!gameInfoCache.has(signal.game_pk)) {
        gameInfoCache.set(signal.game_pk, await getGameInfo(db, signal.game_pk));
      }
      const gameInfo = gameInfoCache.get(signal.game_pk);
      if (!gameInfo) continue;

      if (!finalScoreCache.has(signal.game_pk)) {
        const linescoreRaw = await fetchGameLinescore(signal.game_pk);
        finalScoreCache.set(signal.game_pk, extractFinalScore(linescoreRaw));
      }
      const score = finalScoreCache.get(signal.game_pk);
      if (!score) continue;

      if (!persistedResults.has(signal.game_pk)) {
        await upsertGameResult(db, signal.game_pk, { homeScore: score.home, awayScore: score.away, final: true });
        persistedResults.add(signal.game_pk);
      }

      let hit = null;
      let actualValue = null;

      if (signal.market === 'moneyline') {
        hit = gradeMoneylineSignal({ selection: signal.selection, homeTeam: gameInfo.homeTeam, homeScore: score.home, awayScore: score.away });
        actualValue = `${gameInfo.homeTeam} ${score.home} - ${score.away} ${gameInfo.awayTeam}`;
      } else if (signal.market === 'totals') {
        hit = gradeTotalsSignal({ selection: signal.selection, line: signal.line, homeScore: score.home, awayScore: score.away });
        if (hit === null) continue;
        actualValue = `${score.home + score.away} carreras`;
      } else if (signal.market === 'player_prop' || signal.market === 'pitcher_strikeouts') {
        if (!boxscoreCache.has(signal.game_pk)) {
          boxscoreCache.set(signal.game_pk, await fetchGameBoxscore(signal.game_pk));
        }
        const boxscore = boxscoreCache.get(signal.game_pk);
        const actual = signal.market === 'player_prop'
          ? extractPlayerBattingHits(boxscore, signal.subject_id)
          : extractPlayerPitchingStrikeouts(boxscore, signal.subject_id);
        if (actual == null) continue;
        hit = gradeOverSignal({ line: signal.line, actualValue: actual });
        if (hit === null) continue;
        actualValue = signal.market === 'player_prop' ? `${actual} hits` : `${actual} ponches`;
      } else {
        continue;
      }

      await markSignalGraded(db, signal.id, { hit, actualValue });
      graded.push({ ...signal, hit, actualValue, gameInfo });
    } catch (err) {
      console.error(`Failed to grade signal ${signal.id} (game ${signal.game_pk}):`, err);
    }
  }

  await sendReportMessages(graded, date);

  return {
    date,
    gradedCount: graded.length,
    hits: graded.filter(g => g.hit).length,
    misses: graded.filter(g => !g.hit).length,
  };
}

async function sendReportMessages(graded, date) {
  if (graded.length === 0) {
    await sendTelegramMessage(
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.TELEGRAM_CHAT_ID,
      `📊 Reporte de resultados ${date}: no había señales para calificar (o los juegos aún no habían terminado).`
    );
    return;
  }

  const hits = graded.filter(g => g.hit);
  const misses = graded.filter(g => !g.hit);
  const accuracy = ((hits.length / graded.length) * 100).toFixed(1);

  let content = `REPORTE DE RESULTADOS — ${date}\n\n`;
  content += `Total de señales calificadas: ${graded.length}\nAciertos: ${hits.length}\nFallos: ${misses.length}\nTasa de acierto: ${accuracy}%\n\n`;

  const byMarket = {};
  for (const g of graded) {
    byMarket[g.market] = byMarket[g.market] || { hits: 0, total: 0 };
    byMarket[g.market].total += 1;
    if (g.hit) byMarket[g.market].hits += 1;
  }
  content += 'Por tipo de señal:\n';
  for (const [market, stats] of Object.entries(byMarket)) {
    content += `- ${MARKET_LABELS[market] || market}: ${stats.hits}/${stats.total} (${((stats.hits / stats.total) * 100).toFixed(0)}%)\n`;
  }

  const totalsMisses = misses.filter(g => g.market === 'totals');
  if (totalsMisses.length >= 2) {
    const overMisses = totalsMisses.filter(g => g.selection.startsWith('Over')).length;
    const underMisses = totalsMisses.filter(g => g.selection.startsWith('Under')).length;
    if (overMisses > underMisses) {
      content += `\nPatrón: ${overMisses} de ${totalsMisses.length} fallos de totales fueron señales de Over — el modelo pudo haber sobreestimado las carreras en esos juegos.\n`;
    } else if (underMisses > overMisses) {
      content += `\nPatrón: ${underMisses} de ${totalsMisses.length} fallos de totales fueron señales de Under — el modelo pudo haber subestimado las carreras en esos juegos.\n`;
    }
  }

  const hitsList = graded.filter(g => g.hit);
  const missesList = graded.filter(g => !g.hit);

  content += `\nACIERTOS (${hitsList.length}):\n\n`;
  for (const g of hitsList) {
    const matchup = `${g.gameInfo.awayTeam} @ ${g.gameInfo.homeTeam}`;
    content += `[${MARKET_LABELS[g.market] || g.market}] ${matchup} — ${g.selection}. Real: ${g.actualValue}\n`;
  }

  content += `\nFALLOS (${missesList.length}):\n\n`;
  for (const g of missesList) {
    const matchup = `${g.gameInfo.awayTeam} @ ${g.gameInfo.homeTeam}`;
    content += `[${MARKET_LABELS[g.market] || g.market}] ${matchup} — ${g.selection}. Real: ${g.actualValue}\n`;
  }

  const filename = `reporte_resultados_${date}.txt`;
  await sendTelegramDocument(
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_CHAT_ID,
    filename,
    content,
    `📊 Reporte ${date}: ${hits.length}/${graded.length} aciertos (${accuracy}%)`
  );
}

export default async function handler(req, res) {
  if (req.query?.secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const result = await runNightlyReport();
    res.status(200).json(result);
  } catch (err) {
    console.error('nightly-report.js error:', err);
    res.status(500).json({ error: err.message });
  }
}
