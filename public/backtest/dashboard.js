// public/backtest/dashboard.js
const MARKET_LABELS = { moneyline: 'Moneyline', totals: 'Totales', pitcher_strikeouts: 'Ponches', player_prop: 'Hits bateador' };
const MARKET_COLORS = { totals: '#4f8cff', pitcher_strikeouts: '#ff9f4f', player_prop: '#35c07a' };

let secret = localStorage.getItem('mlbBacktestSecret') || '';
let runs = [];
let currentRunId = null;
let biasChart = null;
let mlChart = null;

function api(action, params = {}) {
  const qs = new URLSearchParams({ secret, action, ...params });
  return fetch(`/api/backtest-data?${qs}`).then(async r => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  });
}

function fmt(n, digits = 2) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function renderCards(marketSummary) {
  const cards = document.getElementById('cards');
  cards.innerHTML = '';
  for (const market of ['moneyline', 'totals', 'pitcher_strikeouts', 'player_prop']) {
    const m = marketSummary[market];
    const card = document.createElement('div');
    card.className = 'card';
    let body;
    if (!m) {
      body = `<div class="empty">Sin predicciones todavía</div>`;
    } else if (market === 'moneyline') {
      body = `
        <div class="metric-row"><span class="label">Predicciones</span><span class="value">${m.n}</span></div>
        <div class="metric-row" title="De todas las veces que el modelo dijo quién iba a ganar, en cuántas acertó."><span class="label">Precisión (¿acertó?)</span><span class="value">${fmt(m.accuracy * 100, 1)}%</span></div>
        <div class="metric-row" title="Qué tan bien calibradas están las probabilidades, no solo si acertó el ganador. 0 = perfecto, 0.25 = como no saber nada y siempre decir 50/50, 1 = muy seguro y muy equivocado."><span class="label">Qué tan confiable es el % (0 = perfecto, 0.25 = adivinando)</span><span class="value">${fmt(m.brier, 3)}</span></div>
      `;
    } else {
      body = `
        <div class="metric-row"><span class="label">Predicciones</span><span class="value">${m.n}</span></div>
        <div class="metric-row"><span class="label">Sesgo (real − proy.)</span><span class="value">${m.bias >= 0 ? '+' : ''}${fmt(m.bias)}</span></div>
        <div class="metric-row" title="Diferencia promedio entre lo que predijo el modelo y lo que pasó en la realidad, sin importar si fue por arriba o por abajo. Ej: si dice 5.6 y el juego terminó 3 arriba o 3 abajo en promedio, esto marca 3."><span class="label">Qué tan lejos, en promedio</span><span class="value">${fmt(m.mae)}</span></div>
        <div class="metric-row" title="Como el de arriba, pero castiga más fuerte los fallos grandes. Si este número es bastante más alto que el de arriba, hay algunos fallos gigantes escondidos entre muchos aciertos cercanos."><span class="label">Qué tan feo cuando falla</span><span class="value">${fmt(m.rmse)}</span></div>
      `;
    }
    card.innerHTML = `<h3>${MARKET_LABELS[market]}</h3>${body}`;
    cards.appendChild(card);
  }
}

function renderBiasChart(daily) {
  const ctx = document.getElementById('biasChart');
  const labels = daily.map(d => d.date);
  const datasets = ['totals', 'pitcher_strikeouts', 'player_prop'].map(market => ({
    label: MARKET_LABELS[market],
    data: daily.map(d => d[market] ? d[market].bias : null),
    borderColor: MARKET_COLORS[market],
    backgroundColor: MARKET_COLORS[market],
    spanGaps: true,
    tension: 0.2,
  }));
  if (biasChart) biasChart.destroy();
  biasChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      scales: {
        x: { ticks: { color: '#8b909c' }, grid: { color: '#2a2e38' } },
        y: { ticks: { color: '#8b909c' }, grid: { color: '#2a2e38' }, title: { display: true, text: 'Sesgo (real − proyectado)', color: '#8b909c' } },
      },
      plugins: { legend: { labels: { color: '#e6e8ec' } } },
    },
  });
}

function renderMlChart(daily) {
  const ctx = document.getElementById('mlChart');
  const labels = daily.map(d => d.date);
  if (mlChart) mlChart.destroy();
  mlChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Precisión (¿acertó?)', data: daily.map(d => d.moneyline ? d.moneyline.accuracy : null), borderColor: '#4f8cff', backgroundColor: '#4f8cff', spanGaps: true, tension: 0.2, yAxisID: 'y' },
        { label: 'Qué tan confiable es el % (más bajo = mejor)', data: daily.map(d => d.moneyline ? d.moneyline.brier : null), borderColor: '#ff5d5d', backgroundColor: '#ff5d5d', spanGaps: true, tension: 0.2, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { ticks: { color: '#8b909c' }, grid: { color: '#2a2e38' } },
        y: { position: 'left', min: 0, max: 1, ticks: { color: '#8b909c' }, grid: { color: '#2a2e38' } },
        y1: { position: 'right', min: 0, max: 1, ticks: { color: '#8b909c' }, grid: { display: false } },
      },
      plugins: { legend: { labels: { color: '#e6e8ec' } } },
    },
  });
}

function renderDailyTable(daily) {
  const tbody = document.getElementById('dailyTableBody');
  tbody.innerHTML = '';
  for (const d of daily) {
    const tr = document.createElement('tr');
    const cell = (m) => m ? `${m.n} / ${m.accuracy !== undefined ? fmt(m.accuracy * 100, 0) + '%' : (m.bias >= 0 ? '+' : '') + fmt(m.bias)} / ${m.brier !== undefined ? fmt(m.brier, 3) : fmt(m.mae)}` : '—';
    tr.innerHTML = `
      <td><a class="day-link" data-date="${d.date}">${d.date}</a></td>
      <td>${cell(d.moneyline)}</td>
      <td>${cell(d.totals)}</td>
      <td>${cell(d.pitcher_strikeouts)}</td>
      <td>${cell(d.player_prop)}</td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('.day-link').forEach(el => {
    el.addEventListener('click', () => loadDetail(el.dataset.date));
  });
}

const MARKET_ORDER = ['moneyline', 'totals', 'pitcher_strikeouts', 'player_prop'];

// Same "acierto"/"fallo" rule for every count-based market: round the model's own projection
// to the nearest whole number and treat that as the implied "over" line — e.g. a 5.4-strikeout
// projection means "at least 5"; 5 or more actual strikeouts is a hit, 4 or fewer is a miss.
// Moneyline just compares the favored side against what actually happened.
function isHit(p) {
  if (p.projected_prob != null && p.actual_outcome != null) {
    return (p.projected_prob > 0.5) === p.actual_outcome;
  }
  if (p.projected_value != null && p.actual_value != null) {
    return p.actual_value >= Math.round(p.projected_value);
  }
  return null;
}

function buildReasoning(p) {
  const f = p.factors || {};
  const pct = (v) => (typeof v === 'number' ? (v * 100).toFixed(1) + '%' : '—');
  const num = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '—');

  if (p.market === 'moneyline') {
    const favored = p.projected_prob > 0.5 ? p.home_team : p.away_team;
    const won = p.actual_outcome;
    const winner = won ? p.home_team : p.away_team;
    return `El modelo le dio ${pct(p.projected_prob)} de probabilidad de ganar a ${p.home_team} (local), comparando ERA (local ${num(f.homeEra)} vs. visitante ${num(f.awayEra)}), forma reciente (últimos 10: local ${num(f.homeLast10 * 10, 0)}-${num(10 - f.homeLast10 * 10, 0)}, visitante ${num(f.awayLast10 * 10, 0)}-${num(10 - f.awayLast10 * 10, 0)}) y qué tan bien batea cada lineup contra la mano del pitcher rival (factor ofensivo local ${num(f.homeOffensiveFactor)}x, visitante ${num(f.awayOffensiveFactor)}x). Con eso, favoreció a ${favored}. En la realidad ganó ${winner}.`;
  }
  if (p.market === 'totals') {
    const threshold = Math.round(p.projected_value);
    return `El modelo proyectó ${num(p.projected_value, 1)} carreras combinadas (equivalente a esperar al menos ${threshold}), usando el promedio de carreras de cada equipo (local ${num(f.homeBlendedRPG)}, visitante ${num(f.awayBlendedRPG)}) ajustado por el ERA de cada abridor (local ${num(f.homeEra)}, visitante ${num(f.awayEra)}) y el factor ofensivo de cada lineup contra la mano rival (local ${num(f.homeOffensiveFactor)}x, visitante ${num(f.awayOffensiveFactor)}x). Terminaron anotando ${num(p.actual_value, 0)}.`;
  }
  if (p.market === 'pitcher_strikeouts') {
    const threshold = Math.round(p.projected_value);
    return `El modelo proyectó ${num(p.projected_value, 1)} ponches para ${p.selection} (al menos ${threshold}), a partir de su K/9 (${num(f.pitcherK9)}), innings esperados (${num(f.inningsPerStart, 1)}${f.adjustedInnings < f.inningsPerStart - 0.05 ? `, reducidos a ${num(f.adjustedInnings, 1)} por riesgo de salida corta con ERA ${num(f.ownEra)}` : ''}), la tasa de ponches del rival (${pct(f.opposingStrikeoutRate)}), la mezcla poder/contacto de su lineup (factor ${num(f.powerContactFactor)}x), el parque (${num(f.parkFactor)}x) y el clima (factor ${num(f.weatherFactor)}x). Terminó con ${num(p.actual_value, 0)} ponches.`;
  }
  if (p.market === 'player_prop') {
    const threshold = Math.round(p.projected_value);
    return `El modelo proyectó ${num(p.projected_value)} hits para ${p.selection} (al menos ${threshold}), usando su promedio de bateo (${num(f.avg, 3)}) y turnos al bate por juego (${num(f.paPerGame, 1)}). Terminó con ${num(p.actual_value, 0)} hits.`;
  }
  return '';
}

function renderPredCard(p) {
  const proj = p.projected_prob != null ? `${fmt(p.projected_prob * 100, 1)}%` : fmt(p.projected_value);
  const actual = p.actual_outcome != null ? (p.actual_outcome ? 'Ganó' : 'Perdió') : fmt(p.actual_value, 0);
  const div = document.createElement('div');
  div.className = 'pred-card';
  div.innerHTML = `
    <div class="pred-head">
      <span class="sel">${p.selection || '—'}</span>
      <span class="matchup">${p.away_team} @ ${p.home_team}</span>
      <span class="nums">proyectado ${proj} — real ${actual}</span>
    </div>
    <div class="reasoning">${buildReasoning(p)}</div>
  `;
  return div;
}

async function loadDetail(date) {
  document.getElementById('detailTitle').textContent = `Predicciones del ${date}`;
  const { predictions } = await api('detail', { runId: currentRunId, date });

  const hits = predictions.filter(p => isHit(p) === true);
  const misses = predictions.filter(p => isHit(p) === false);

  const container = document.getElementById('detailSections');
  container.innerHTML = '';
  if (predictions.length === 0) {
    container.innerHTML = '<div class="empty-note">No hay predicciones para este día.</div>';
    return;
  }

  for (const [sectionClass, label, rows] of [['hits', `✅ Aciertos (${hits.length})`, hits], ['misses', `❌ Fallos (${misses.length})`, misses]]) {
    const section = document.createElement('div');
    section.className = `result-section ${sectionClass}`;
    section.innerHTML = `<h4>${label}</h4>`;
    if (rows.length === 0) {
      section.innerHTML += '<div class="empty-note">Ninguno.</div>';
    } else {
      for (const market of MARKET_ORDER) {
        const marketRows = rows.filter(p => p.market === market);
        if (marketRows.length === 0) continue;
        const group = document.createElement('div');
        group.className = 'market-group';
        group.innerHTML = `<h5>${MARKET_LABELS[market] || market} (${marketRows.length})</h5>`;
        for (const p of marketRows) group.appendChild(renderPredCard(p));
        section.appendChild(group);
      }
    }
    container.appendChild(section);
  }
}

async function loadRuns() {
  const { runs: fetchedRuns } = await api('runs');
  runs = fetchedRuns;
  const select = document.getElementById('runSelect');
  select.innerHTML = runs.map(r => `<option value="${r.id}">#${r.id} — ${r.from_date} a ${r.to_date}${r.model_note ? ` (${r.model_note})` : ''}${r.finished_at ? '' : ' [en progreso]'}</option>`).join('');
  if (runs.length > 0) {
    currentRunId = runs[0].id;
    select.value = currentRunId;
    await loadRun(currentRunId);
  }
}

async function loadRun(runId) {
  currentRunId = runId;
  const run = runs.find(r => String(r.id) === String(runId));
  document.getElementById('runMeta').textContent = run
    ? `Corrida iniciada ${new Date(run.started_at).toLocaleString('es')}${run.finished_at ? ', terminada ' + new Date(run.finished_at).toLocaleString('es') : ' — todavía corriendo'}`
    : '';
  const { marketSummary, daily } = await api('summary', { runId });
  renderCards(marketSummary);
  renderBiasChart(daily);
  renderMlChart(daily);
  renderDailyTable(daily);
  document.getElementById('detailTableBody').innerHTML = '';
  document.getElementById('detailTitle').textContent = 'Predicciones del día (elige una fecha arriba)';
}

function showApp() {
  document.getElementById('gate').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  loadRuns().catch(err => alert('Error cargando datos: ' + err.message));
}

document.getElementById('secretSubmit').addEventListener('click', () => {
  secret = document.getElementById('secretInput').value.trim();
  if (!secret) return;
  localStorage.setItem('mlbBacktestSecret', secret);
  showApp();
});
document.getElementById('secretInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('secretSubmit').click();
});
document.getElementById('runSelect').addEventListener('change', (e) => loadRun(e.target.value));
document.getElementById('refreshBtn').addEventListener('click', () => loadRuns());

if (secret) showApp();
