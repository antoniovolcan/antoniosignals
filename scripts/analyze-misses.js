// scripts/analyze-misses.js
// Usage: node --env-file=.env scripts/analyze-misses.js <runId> [--market=totals] [--limit=100]
//
// Runs the post-mortem miss analysis (lib/missAnalysis.js) over every miss in a backtest run,
// then aggregates the suggested adjustments by frequency so you can see which patterns show up
// most often before deciding what to actually change in the model. This makes real MLB API calls
// per miss (play-by-play + batter-vs-hand lookups), so it can take a while on a large run — use
// --market and --limit to scope it down.
import { createDbClient, getBacktestPredictions } from '../lib/db.js';
import { analyzeMiss } from '../lib/missAnalysis.js';

function impliedThreshold(v) { return Math.ceil(v); }
// Must match the grading rule in public/backtest/dashboard.js's isHit().
function isHit(p) {
  if (p.projected_prob != null && p.actual_outcome != null) return (p.projected_prob > 0.5) === p.actual_outcome;
  if (p.projected_value != null && p.actual_value != null) return p.actual_value >= impliedThreshold(p.projected_value);
  return null;
}

async function main() {
  const [, , runIdArg, ...rest] = process.argv;
  if (!runIdArg) {
    console.error('Usage: node --env-file=.env scripts/analyze-misses.js <runId> [--market=totals] [--limit=100]');
    process.exit(1);
  }
  const runId = Number(runIdArg);
  const marketArg = rest.find(a => a.startsWith('--market='))?.split('=')[1];
  const limitArg = Number(rest.find(a => a.startsWith('--limit='))?.split('=')[1] || 200);

  const db = createDbClient();
  const all = await getBacktestPredictions(db, { runId, market: marketArg });
  const misses = all.filter(p => isHit(p) === false).slice(0, limitArg);
  console.log(`Run #${runId}: ${misses.length} fallos a analizar${marketArg ? ` (mercado: ${marketArg})` : ''} de ${all.length} predicciones totales.\n`);

  const results = [];
  for (let i = 0; i < misses.length; i++) {
    const miss = misses[i];
    process.stdout.write(`\rAnalizando ${i + 1}/${misses.length}...`);
    try {
      const analysis = await analyzeMiss(miss);
      results.push({ miss, analysis });
    } catch (err) {
      console.error(`\nError analizando predicción ${miss.id} (game ${miss.game_pk}):`, err.message);
    }
  }
  console.log('\n');

  const suggestionCounts = new Map();
  for (const { analysis } of results) {
    for (const s of analysis.suggestions || []) {
      suggestionCounts.set(s, (suggestionCounts.get(s) || 0) + 1);
    }
  }

  console.log('='.repeat(80));
  console.log('PATRONES ENCONTRADOS (ordenados por frecuencia) — revisa cuáles aplicar:');
  console.log('='.repeat(80));
  const sorted = [...suggestionCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) console.log('\nNo se encontraron patrones recurrentes.');
  for (const [suggestion, count] of sorted) {
    console.log(`\n[${count}x] ${suggestion}`);
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log('DETALLE POR MERCADO:');
  console.log('='.repeat(80));
  const byMarket = {};
  for (const r of results) (byMarket[r.miss.market] ||= []).push(r);
  for (const [market, items] of Object.entries(byMarket)) {
    console.log(`\n--- ${market.toUpperCase()} (${items.length} fallos) ---`);
    for (const { miss, analysis } of items) {
      console.log(`\n[${miss.game_date}] ${miss.away_team} @ ${miss.home_team} — ${miss.selection || 'total'}`);
      console.log(analysis.narrative);
    }
  }
}

main().catch(err => {
  console.error('analyze-misses failed:', err);
  process.exit(1);
});
