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

export async function signalAlreadySentToday(db, gamePk, market, selection) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from('signals')
    .select('id')
    .eq('game_pk', gamePk)
    .eq('market', market)
    .eq('selection', selection)
    .gte('sent_at', `${today}T00:00:00Z`)
    .limit(1);
  if (error) throw error;
  return data.length > 0;
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

export async function getConfigValue(db, key, defaultValue) {
  const { data, error } = await db.from('config').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : defaultValue;
}

export async function setConfigValue(db, key, value) {
  const { error } = await db.from('config').upsert({ key, value: String(value) }, { onConflict: 'key' });
  if (error) throw error;
}
