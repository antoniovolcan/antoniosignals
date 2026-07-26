// lib/missAnalysis.js
// Post-mortem analysis for a single backtest miss: pulls the game's real play-by-play, figures out
// which batters actually drove the outcome, and cross-references them against their season-to-date
// vs.-pitcher-hand profile to tell apart "the model underweighted a batter who was already dangerous
// against that hand" from "this was a hard-to-predict anomaly". Not used in any live projection —
// this is a diagnostic tool you run after the fact to decide what to tune.
import {
  fetchPlayByPlay, extractPlateAppearances, extractNotableHits,
  fetchBatterHittingVsHand, extractBattingAvgAndPA, extractPowerContactProfile,
  fetchGameLinescore, extractFinalScore,
} from './mlb.js';

const HAND_LABEL_PLURAL = { L: 'zurdos', R: 'derechos' };

async function describeBatterDanger(batterId, batterName, hand, season) {
  try {
    const raw = await fetchBatterHittingVsHand(batterId, hand, season);
    const { avg } = extractBattingAvgAndPA(raw);
    const { hrRate } = extractPowerContactProfile(raw);
    const handLabel = HAND_LABEL_PLURAL[hand] || 'esa mano';
    const dangerous = avg > 0.260 || hrRate > 0.035;
    return {
      batterId, batterName, avg, hrRate, dangerous,
      text: `${batterName} batea .${String(Math.round(avg * 1000)).padStart(3, '0')} con ${(hrRate * 100).toFixed(1)}% de tasa de jonrones contra lanzadores ${handLabel} esta temporada — ${dangerous ? 'ya era un bateador con perfil peligroso contra esa mano; el modelo pudo haberlo subestimado' : 'no destacaba especialmente contra esa mano, esto luce más como una anomalía puntual que como algo predecible'}.`,
    };
  } catch (err) {
    return { batterId, batterName, avg: null, hrRate: null, dangerous: null, text: `No se pudo obtener el perfil de ${batterName} contra esa mano.` };
  }
}

function groupNotableHitsByBatter(hits) {
  const byBatter = new Map();
  for (const h of hits) {
    if (!byBatter.has(h.batterId)) byBatter.set(h.batterId, { batterId: h.batterId, batterName: h.batterName, pitchHand: h.pitchHand, events: [], rbi: 0 });
    const entry = byBatter.get(h.batterId);
    entry.events.push(h.event);
    entry.rbi += h.rbi;
  }
  return [...byBatter.values()].sort((a, b) => b.rbi - a.rbi);
}

async function analyzeMoneylineMiss(prediction, pas, season, scoreLine) {
  const favoredHome = prediction.projected_prob > 0.5;
  const favored = favoredHome ? prediction.home_team : prediction.away_team;
  const winnerIsHome = prediction.actual_outcome;
  const winner = winnerIsHome ? prediction.home_team : prediction.away_team;

  const winningTeamHits = groupNotableHitsByBatter(
    extractNotableHits(pas).filter(h => (h.halfInning === 'bottom') === winnerIsHome)
  ).slice(0, 5);
  const profiles = await Promise.all(winningTeamHits.map(b => describeBatterDanger(b.batterId, b.batterName, b.pitchHand, season)));

  const underestimatedCount = profiles.filter(p => p.dangerous).length;
  const narrative = `El modelo favoreció a ${favored}, pero ganó ${winner} (${scoreLine}). Los bateadores de ${winner} que más influyeron con hits de extrabase o jonrones: ${winningTeamHits.map(b => `${b.batterName} (${b.events.join(', ')}${b.rbi ? `, ${b.rbi} RBI` : ''})`).join('; ') || 'ninguno destacado — el partido se decidió por otras vías (walks, errores, bullpen, etc.), no por hits fuertes puntuales'}. ${profiles.map(p => p.text).join(' ')}`;

  const suggestions = [];
  if (underestimatedCount >= Math.ceil(profiles.length / 2) && profiles.length > 0) {
    suggestions.push('Varios de los bateadores clave ya tenían un perfil peligroso contra esa mano — considerar dar más peso al historial bateador-vs-mano específico (no solo el promedio del lineup) en el factor ofensivo del moneyline.');
  }
  if (winningTeamHits.length === 0) {
    suggestions.push('No hubo hits de extrabase/jonrones decisivos del lado ganador — vale la pena revisar el bullpen, errores defensivos o walks del rival, factores que el modelo no usa todavía.');
  }
  return { narrative, suggestions, keyBatters: profiles };
}

async function analyzeTotalsMiss(prediction, pas, season, scoreLine) {
  const notable = extractNotableHits(pas);
  const byInning = new Map();
  for (const h of notable) {
    const key = `${h.inning}${h.halfInning === 'top' ? 'A' : 'B'}`;
    byInning.set(key, (byInning.get(key) || 0) + h.rbi);
  }
  const bigInnings = [...byInning.entries()].filter(([, rbi]) => rbi >= 2).sort((a, b) => b[1] - a[1]);
  const grouped = groupNotableHitsByBatter(notable).slice(0, 6);
  const profiles = await Promise.all(grouped.map(b => describeBatterDanger(b.batterId, b.batterName, b.pitchHand, season)));

  const direction = prediction.actual_value > prediction.projected_value ? 'por encima' : 'por debajo';
  const narrative = `El modelo proyectó ${prediction.projected_value.toFixed(1)} carreras y terminaron anotando ${prediction.actual_value} (${scoreLine}) — quedó ${direction} de lo proyectado. ${bigInnings.length > 0 ? `Hubo ${bigInnings.length} entrada(s) con 2+ carreras que dispararon el total.` : 'No hubo una entrada explosiva puntual — el total se acumuló de forma más pareja.'} Bateadores con hits de extrabase/jonrones en el juego: ${grouped.map(b => `${b.batterName} (${b.events.join(', ')})`).join('; ') || 'ninguno notable'}. ${profiles.map(p => p.text).join(' ')}`;

  const suggestions = [];
  if (bigInnings.length > 0) suggestions.push('El error se concentró en pocas entradas explosivas — esto es difícil de proyectar con promedios; considerar si vale la pena modelar varianza/rachas en vez de solo el valor esperado.');
  if (profiles.some(p => p.dangerous)) suggestions.push('Algunos de los bateadores que más aportaron ya destacaban contra esa mano — reforzar el peso del factor ofensivo específico vs. mano en la proyección de carreras.');
  return { narrative, suggestions, keyBatters: profiles };
}

async function analyzeStrikeoutsMiss(prediction, pas, season, scoreLine) {
  const pitcherPAs = pas.filter(p => p.pitcherId === prediction.subject_id);
  const strikeouts = pitcherPAs.filter(p => p.event === 'Strikeout');
  const ballsInPlay = pitcherPAs.filter(p => !['Strikeout', 'Walk', 'Hit By Pitch', 'Intent Walk'].includes(p.event));
  const contactHitters = groupNotableHitsByBatter(extractNotableHits(pitcherPAs)).slice(0, 5);
  const profiles = await Promise.all(contactHitters.map(b => describeBatterDanger(b.batterId, b.batterName, b.pitchHand, season)));

  const direction = prediction.actual_value < prediction.projected_value ? 'menos' : 'más';
  const contactRate = pitcherPAs.length > 0 ? (ballsInPlay.length / pitcherPAs.length) : null;
  const narrative = `El modelo proyectó ${prediction.projected_value.toFixed(1)} ponches para ${prediction.selection} y terminó con ${prediction.actual_value} — ${direction} de lo esperado. Lanzó a ${pitcherPAs.length} bateadores (${strikeouts.length} ponches, ${ballsInPlay.length} bateadores que pusieron la bola en juego${contactRate != null ? `, ${(contactRate * 100).toFixed(0)}% de contacto` : ''}). ${contactHitters.length > 0 ? `Los que más contacto de calidad le dieron: ${contactHitters.map(b => `${b.batterName} (${b.events.join(', ')})`).join('; ')}.` : ''} ${profiles.map(p => p.text).join(' ')}`;

  const suggestions = [];
  if (pitcherPAs.length < 15) suggestions.push('El pitcher enfrentó pocos bateadores (posible salida corta) — revisar si el ajuste de innings por riesgo de salida temprana necesita ser más agresivo.');
  if (profiles.some(p => !p.dangerous) && contactHitters.length > 0) suggestions.push('Algunos bateadores que le hicieron contacto no destacaban por buen promedio — podría ser variación normal, no necesariamente algo para ajustar en el modelo.');
  return { narrative, suggestions, keyBatters: profiles };
}

async function analyzeHitsMiss(prediction, pas, season, scoreLine) {
  const batterPAs = pas.filter(p => p.batterId === prediction.subject_id);
  const hits = batterPAs.filter(p => ['Single', 'Double', 'Triple', 'Home Run'].includes(p.event));
  const pitchHands = [...new Set(batterPAs.map(p => p.pitchHand).filter(Boolean))];
  const profile = pitchHands.length === 1 ? await describeBatterDanger(prediction.subject_id, prediction.selection, pitchHands[0], season) : null;

  const direction = prediction.actual_value < prediction.projected_value ? 'menos' : 'más';
  const narrative = `El modelo proyectó ${prediction.projected_value.toFixed(2)} hits para ${prediction.selection} y terminó con ${prediction.actual_value} — ${direction} de lo esperado, en ${batterPAs.length} turnos (${batterPAs.map(p => p.event).join(', ') || 'sin datos de turnos'}).${profile ? ` ${profile.text}` : ''}`;

  const suggestions = [];
  if (batterPAs.length <= 2) suggestions.push('Tuvo pocos turnos al bate ese día (posible cambio de lineup, lesión, o salió del juego temprano) — esto es ruido normal de muestra chica, no necesariamente algo que el modelo deba corregir.');
  return { narrative, suggestions, keyBatters: profile ? [profile] : [] };
}

export async function analyzeMiss(prediction) {
  const season = Number(String(prediction.game_date).slice(0, 4));
  const [pbpRaw, linescoreRaw] = await Promise.all([
    fetchPlayByPlay(prediction.game_pk),
    fetchGameLinescore(prediction.game_pk),
  ]);
  const pas = extractPlateAppearances(pbpRaw);
  const score = extractFinalScore(linescoreRaw);
  const scoreLine = score ? `${prediction.home_team} ${score.home} - ${score.away} ${prediction.away_team}` : 'marcador no disponible';

  if (prediction.market === 'moneyline') return analyzeMoneylineMiss(prediction, pas, season, scoreLine);
  if (prediction.market === 'totals') return analyzeTotalsMiss(prediction, pas, season, scoreLine);
  if (prediction.market === 'pitcher_strikeouts') return analyzeStrikeoutsMiss(prediction, pas, season, scoreLine);
  if (prediction.market === 'player_prop') return analyzeHitsMiss(prediction, pas, season, scoreLine);
  return { narrative: `Mercado "${prediction.market}" no soportado para este análisis.`, suggestions: [], keyBatters: [] };
}
