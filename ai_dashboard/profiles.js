import Chart from 'chart.js/auto';

const BACKEND_URL = import.meta.env?.VITE_BACKEND_URL || 'http://localhost:8000';

let trendChart = null;
let bandChart = null;

function parseTs(ts) {
  if (!ts) return new Date();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function bandLabel(band) {
  if (!band) return 'unknown';
  return band.replace('4_6_hz', '4–6 Hz').replace('6_8_hz', '6–8 Hz').replace('8_12_hz', '8–12 Hz');
}

function computeAggregate(sessions) {
  if (!sessions.length) {
    return { mean: null, slope: 0 };
  }
  const scores = sessions.map(s => s.mean_score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;

  if (sessions.length < 2) return { mean, slope: 0 };

  const xs = sessions.map(s => parseTs(s.timestamp).getTime());
  const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ym = mean;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - xm) * (sessions[i].mean_score - ym);
    den += (xs[i] - xm) ** 2;
  }
  const slopePerMs = den ? num / den : 0;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const slopePerWeek = slopePerMs * weekMs;
  return { mean, slope: slopePerWeek };
}

function updateSummaryCards(sessions) {
  const countEl = document.getElementById('profileSessionCount');
  const meanEl = document.getElementById('profileMeanScore');
  const trendEl = document.getElementById('profileTrendLabel');
  const badge = document.getElementById('trendBadgeProfile');

  countEl.textContent = String(sessions.length);

  if (!sessions.length) {
    meanEl.textContent = '—';
    trendEl.textContent = 'No data yet';
    badge.textContent = '—';
    badge.style.color = '#64748b';
    return;
  }

  const { mean, slope } = computeAggregate(sessions);
  meanEl.textContent = mean.toFixed(2);

  const dir = slope >= 0 ? '+' : '';
  const label = `${dir}${slope.toFixed(2)} / week`;
  trendEl.textContent = slope > 0.1 ? 'Worsening' : slope < -0.1 ? 'Improving' : 'Stable';

  badge.textContent = label;
  badge.style.color = slope > 0.1 ? '#ef4444' : slope < -0.1 ? '#22c55e' : '#64748b';
}

function initTrendChart(ctx, sessions) {
  const labels = sessions.map(s => parseTs(s.timestamp).toLocaleDateString());
  const data = sessions.map(s => s.mean_score);

  if (trendChart) {
    trendChart.data.labels = labels;
    trendChart.data.datasets[0].data = data;
    trendChart.update('none');
    return;
  }

  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: '#2dd4bf',
        backgroundColor: 'rgba(45,212,191,0.15)',
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: '#22c55e',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `Mean score: ${ctx.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: 'rgba(148,163,184,0.8)', font: { size: 10 } },
          grid: { color: 'rgba(30,41,59,0.6)' },
        },
        y: {
          ticks: { color: 'rgba(148,163,184,0.8)', font: { size: 10 } },
          grid: { color: 'rgba(30,41,59,0.6)' },
          min: 0,
          max: 10,
        },
      },
    },
  });
}

function initBandChart(ctx, sessions) {
  const labels = sessions.map(s => parseTs(s.timestamp).toLocaleDateString());
  const bands = sessions.map(s => {
    switch (s.dominant_band) {
      case '4_6_hz': return 1;
      case '6_8_hz': return 2;
      case '8_12_hz': return 3;
      default: return 0;
    }
  });

  const bandNames = ['Unknown', '4–6 Hz', '6–8 Hz', '8–12 Hz'];
  const colors = ['#64748b', '#fb7185', '#fbbf24', '#2dd4bf'];

  if (bandChart) {
    bandChart.data.labels = labels;
    bandChart.data.datasets[0].data = bands;
    bandChart.update('none');
    return;
  }

  bandChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: bands,
        borderColor: '#a855f7',
        backgroundColor: 'rgba(168,85,247,0.18)',
        stepped: true,
        fill: true,
        pointRadius: 3,
        pointBackgroundColor: ctx => {
          const v = ctx.parsed.y;
          return colors[v] || colors[0];
        },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `Dominant band: ${bandNames[ctx.parsed.y] || 'Unknown'}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: 'rgba(148,163,184,0.8)', font: { size: 10 } },
          grid: { color: 'rgba(30,41,59,0.6)' },
        },
        y: {
          ticks: {
            color: 'rgba(148,163,184,0.8)',
            callback: v => bandNames[v] || '',
            font: { size: 10 },
          },
          grid: { color: 'rgba(30,41,59,0.6)' },
          min: 0,
          max: 3,
          stepSize: 1,
        },
      },
    },
  });
}

function renderSessionList(sessions) {
  const empty = document.getElementById('sessionListEmpty');
  const wrapper = document.getElementById('sessionList');
  const body = document.getElementById('sessionListBody');

  if (!sessions.length) {
    empty.style.display = 'block';
    wrapper.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  wrapper.style.display = 'block';

  body.innerHTML = '';
  sessions
    .slice()
    .sort((a, b) => parseTs(b.timestamp) - parseTs(a.timestamp))
    .forEach(s => {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors';

      const d = parseTs(s.timestamp);
      const dateStr = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

      tr.innerHTML = `
        <td class="py-2 pr-3 text-slate-300">${dateStr}</td>
        <td class="py-2 pr-3 font-mono text-[10px] text-slate-400">${s.session_id}</td>
        <td class="py-2 pr-3 font-mono text-[11px] text-slate-100">${s.mean_score.toFixed(2)}</td>
        <td class="py-2 pr-3 text-[11px] text-slate-300">${bandLabel(s.dominant_band)}</td>
        <td class="py-2 text-[11px]">
          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold
                       ${s.confidence_level === 'High'
                         ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/40'
                         : s.confidence_level === 'Low'
                         ? 'bg-rose-500/10 text-rose-300 border border-rose-500/40'
                         : 'bg-amber-500/10 text-amber-300 border border-amber-500/40'}">
            ${s.confidence_level}
          </span>
        </td>
      `;

      body.appendChild(tr);
    });
}

async function loadSessions() {
  try {
    const resp = await fetch(BACKEND_URL + '/profile/sessions');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const sessions = await resp.json();

    updateSummaryCards(sessions);
    renderSessionList(sessions);

    if (sessions.length) {
      const tCtx = document.getElementById('profileTrendChart').getContext('2d');
      const bCtx = document.getElementById('profileBandChart').getContext('2d');
      initTrendChart(tCtx, sessions);
      initBandChart(bCtx, sessions);
    }
  } catch (err) {
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSessions();
});

