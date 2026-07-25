// lib/db.js
import { createClient } from '@supabase/supabase-js';

export function createDbClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

export async function upsertGame(db, game) {
  const { error } = await db.from('games').upsert({
    game_pk: game.gamePk,
    date: game.date,
    home_team: game.homeTeam,
    away_team: game.awayTeam,
    status: game.status,
  }, { onConflict: 'game_pk' });
  if (error) throw error;
}

// Returns the id of today's already-recorded signal for this exact market+selection, or null.
// Lets a forced re-scan update that same row with fresh numbers instead of skipping it or
// inserting a duplicate, which would double-count it in the nightly grading report.
export async function getTodaysSignalId(db, gamePk, market, selection) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from('signals')
    .select('id')
    .eq('game_pk', gamePk)
    .eq('market', market)
    .eq('selection', selection)
    .gte('sent_at', `${today}T00:00:00Z`)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? data.id : null;
}

export async function insertSignal(db, signal) {
  const { error } = await db.from('signals').insert({
    game_pk: signal.gamePk,
    market: signal.market,
    selection: signal.selection,
    odds_price: signal.price,
    implied_prob: signal.impliedProb,
    estimated_prob: signal.estimatedProb,
    edge: signal.edge,
    reasoning: signal.reasoning,
    line: signal.line ?? null,
    subject_id: signal.subjectId ?? null,
  });
  if (error) throw error;
}

// Refreshes an already-recorded signal for today (same market+selection) with newly computed
// numbers, instead of inserting a second row — keeps nightly grading at one result per signal per day.
export async function updateSignal(db, id, signal) {
  const { error } = await db.from('signals').update({
    odds_price: signal.price,
    implied_prob: signal.impliedProb,
    estimated_prob: signal.estimatedProb,
    edge: signal.edge,
    reasoning: signal.reasoning,
    line: signal.line ?? null,
  }).eq('id', id);
  if (error) throw error;
}

export async function gameAlreadyScannedToday(db, gamePk) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from('games')
    .select('last_scanned_at')
    .eq('game_pk', gamePk)
    .gte('last_scanned_at', `${today}T00:00:00Z`)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function markGameScanned(db, gamePk) {
  const { error } = await db.from('games').update({ last_scanned_at: new Date().toISOString() }).eq('game_pk', gamePk);
  if (error) throw error;
}

export async function getUngradedSignalsForDate(db, date) {
  const nextDay = new Date(`${date}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const { data, error } = await db
    .from('signals')
    .select('*')
    .is('hit', null)
    .gte('sent_at', `${date}T00:00:00Z`)
    .lt('sent_at', nextDay.toISOString());
  if (error) throw error;
  return data;
}

export async function markSignalGraded(db, signalId, { hit, actualValue }) {
  const { error } = await db
    .from('signals')
    .update({ hit, actual_value: actualValue, graded_at: new Date().toISOString() })
    .eq('id', signalId);
  if (error) throw error;
}

export async function upsertGameResult(db, gamePk, { homeScore, awayScore, final }) {
  const { error } = await db.from('results').upsert({
    game_pk: gamePk,
    home_score: homeScore,
    away_score: awayScore,
    final,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'game_pk' });
  if (error) throw error;
}

export async function getGameInfo(db, gamePk) {
  const { data, error } = await db.from('games').select('home_team, away_team').eq('game_pk', gamePk).maybeSingle();
  if (error) throw error;
  return data ? { homeTeam: data.home_team, awayTeam: data.away_team } : null;
}

export async function getConfigValue(db, key, defaultValue) {
  const { data, error } = await db.from('config').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : defaultValue;
}

export async function setConfigValue(db, key, value) {
  const { error } = await db.from('config').upsert({ key, value: String(value) }, { onConflict: 'key' });
  if (error) throw error;
}

export async function createBacktestRun(db, { fromDate, toDate, modelNote }) {
  const { data, error } = await db
    .from('backtest_runs')
    .insert({ from_date: fromDate, to_date: toDate, model_note: modelNote ?? null })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function finishBacktestRun(db, runId) {
  const { error } = await db.from('backtest_runs').update({ finished_at: new Date().toISOString() }).eq('id', runId);
  if (error) throw error;
}

export async function insertBacktestPredictions(db, predictions) {
  if (predictions.length === 0) return;
  const { error } = await db.from('backtest_predictions').insert(predictions.map(p => ({
    run_id: p.runId,
    game_pk: p.gamePk,
    game_date: p.gameDate,
    market: p.market,
    selection: p.selection ?? null,
    subject_id: p.subjectId ?? null,
    home_team: p.homeTeam,
    away_team: p.awayTeam,
    projected_value: p.projectedValue ?? null,
    projected_prob: p.projectedProb ?? null,
    actual_value: p.actualValue ?? null,
    actual_outcome: p.actualOutcome ?? null,
    factors: p.factors ?? null,
  })));
  if (error) throw error;
}

export async function getBacktestRuns(db, limit = 20) {
  const { data, error } = await db
    .from('backtest_runs')
    .select('id, started_at, finished_at, from_date, to_date, model_note')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export async function getBacktestPredictions(db, { runId, market, fromDate, toDate } = {}) {
  let query = db.from('backtest_predictions').select('*');
  if (runId) query = query.eq('run_id', runId);
  if (market) query = query.eq('market', market);
  if (fromDate) query = query.gte('game_date', fromDate);
  if (toDate) query = query.lte('game_date', toDate);
  const { data, error } = await query.order('game_date', { ascending: true });
  if (error) throw error;
  return data;
}
