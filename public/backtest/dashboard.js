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
        <div class="metric-row"><span class="label">Precisión</span><span class="value">${fmt(m.accuracy * 100, 1)}%</span></div>
        <div class="metric-row"><span class="label">Brier score</span><span class="value">${fmt(m.brier, 3)}</span></div>
      `;
    } else {
      body = `
        <div class="metric-row"><span class="label">Predicciones</span><span class="value">${m.n}</span></div>
        <div class="metric-row"><span class="label">Sesgo (real − proy.)</span><span class="value">${m.bias >= 0 ? '+' : ''}${fmt(m.bias)}</span></div>
        <div class="metric-row"><span class="label">Error promedio (MAE)</span><span class="value">${fmt(m.mae)}</span></div>
        <div class="metric-row"><span class="label">RMSE</span><span class="value">${fmt(m.rmse)}</span></div>
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
        { label: 'Precisión', data: daily.map(d => d.moneyline ? d.moneyline.accuracy : null), borderColor: '#4f8cff', backgroundColor: '#4f8cff', spanGaps: true, tension: 0.2, yAxisID: 'y' },
        { label: 'Brier score (más bajo = mejor)', data: daily.map(d => d.moneyline ? d.moneyline.brier : null), borderColor: '#ff5d5d', backgroundColor: '#ff5d5d', spanGaps: true, tension: 0.2, yAxisID: 'y1' },
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

async function loadDetail(date) {
  document.getElementById('detailTitle').textContent = `Predicciones del ${date}`;
  const { predictions } = await api('detail', { runId: currentRunId, date });
  const tbody = document.getElementById('detailTableBody');
  tbody.innerHTML = '';
  for (const p of predictions) {
    const tr = document.createElement('tr');
    const proj = p.projected_prob != null ? `${fmt(p.projected_prob * 100, 1)}%` : fmt(p.projected_value);
    const actual = p.actual_outcome != null ? (p.actual_outcome ? 'Ganó' : 'Perdió') : fmt(p.actual_value, 0);
    tr.innerHTML = `
      <td>${MARKET_LABELS[p.market] || p.market}</td>
      <td>${p.selection || '—'}</td>
      <td>${p.away_team} @ ${p.home_team}</td>
      <td>${proj}</td>
      <td>${actual}</td>
      <td>${p.factors ? Object.entries(p.factors).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`).join(', ') : '—'}</td>
    `;
    tbody.appendChild(tr);
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
