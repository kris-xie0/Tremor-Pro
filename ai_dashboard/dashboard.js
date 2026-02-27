/* ═══════════════════════════════════════════════════
   IMPORTS — resolved from node_modules by Vite
═══════════════════════════════════════════════════ */
import { gsap } from 'gsap'
import Chart from 'chart.js/auto'


/* ═══════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════ */
let sse = null;
let sessionActive = false;
let sessionWindows = [];
let sessionStartTime = 0;
let calibratedNoiseFloor = null;
let timerInterval = null;
let sessionHistory = JSON.parse(localStorage.getItem('tremorSessionHistory') || '[]');

const BACKEND_URL = import.meta.env?.VITE_BACKEND_URL || 'http://localhost:8000';
const WAVE_LEN = 100;
const waveBuffer = new Array(WAVE_LEN).fill(null);
let waveIdx = 0;

/* ═══════════════════════════════════════════════════
   PARTICLE CANVAS
═══════════════════════════════════════════════════ */
(function initParticles() {
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, pts = [];
  const COLORS = [
    'rgba(45,212,191,', 'rgba(139,92,246,',
    'rgba(167,139,250,', 'rgba(45,212,191,'
  ];

  function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight; }

  function mk() {
    return {
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.4 + 0.3,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
      c: COLORS[Math.floor(Math.random() * COLORS.length)],
      a: Math.random() * 0.5 + 0.1
    };
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    pts.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.c + p.a + ')';
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  resize();
  pts = Array.from({ length: 90 }, mk);
  draw();
})();

/* ═══════════════════════════════════════════════════
   CLOCK
═══════════════════════════════════════════════════ */
function updateClock() {
  const el = document.getElementById('clockDisplay');
  if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

/* ═══════════════════════════════════════════════════
   CHART: LIVE WAVEFORM
═══════════════════════════════════════════════════ */
let waveChart = null;

function initWaveChart() {
  const ctx = document.getElementById('waveCanvas').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 208);
  grad.addColorStop(0, 'rgba(45,212,191,0.42)');
  grad.addColorStop(0.55, 'rgba(45,212,191,0.07)');
  grad.addColorStop(1, 'rgba(45,212,191,0)');

  waveChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array.from({ length: WAVE_LEN }, (_, i) => i),
      datasets: [{
        data: new Array(WAVE_LEN).fill(null),
        borderColor: '#2dd4bf',
        borderWidth: 2,
        backgroundColor: grad,
        fill: true,
        tension: 0.45,
        pointRadius: 0,
        spanGaps: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false, min: 0, max: 10 }
      }
    }
  });
}

/* ═══════════════════════════════════════════════════
   CHART: SCORE SPARKLINE
═══════════════════════════════════════════════════ */
let sparkChart = null;
const sparkBuffer = [];

function initSparkline() {
  const c = document.getElementById('scoreSparkline');
  if (!c) return;
  sparkChart = new Chart(c.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: 'rgba(45,212,191,0.7)', borderWidth: 1.5, fill: false, tension: 0.4, pointRadius: 0 }] },
    options: {
      responsive: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false, min: 0, max: 10 } }
    }
  });
}

/* ═══════════════════════════════════════════════════
   CHART: TREND SPARKLINE
═══════════════════════════════════════════════════ */
let trendChart = null;

function initTrendChart() {
  const ctx = document.getElementById('trendCanvas').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 56);
  grad.addColorStop(0, 'rgba(167,139,250,0.3)');
  grad.addColorStop(1, 'rgba(167,139,250,0)');

  trendChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#a78bfa', borderWidth: 1.5, backgroundColor: grad, fill: true, tension: 0.4, pointRadius: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false, min: 0, max: 10 } }
    }
  });
}

/* ═══════════════════════════════════════════════════
   CHART: DISTRIBUTION DONUT
═══════════════════════════════════════════════════ */
let distChart = null;

function initDistChart() {
  distChart = new Chart(document.getElementById('distChart').getContext('2d'), {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [1, 0, 0, 0],
        backgroundColor: ['rgba(52,211,153,0.75)', 'rgba(251,191,36,0.75)', 'rgba(249,115,22,0.75)', 'rgba(239,68,68,0.75)'],
        borderColor: 'transparent',
        borderWidth: 0,
        hoverOffset: 4
      }]
    },
    options: {
      responsive: false, animation: { duration: 700 },
      cutout: '72%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    }
  });
}

/* ═══════════════════════════════════════════════════
   SVG GAUGE
═══════════════════════════════════════════════════ */
function updateGauge(score) {
  const scoreEl = document.getElementById('gaugeScore');
  const sevEl = document.getElementById('gaugeSeverity');
  const arcEl = document.getElementById('gaugeArc');
  const needle = document.getElementById('gaugeNeedle');
  if (!scoreEl) return;

  const valid = !isNaN(score) && score !== null;
  scoreEl.textContent = valid ? score.toFixed(1) : '—';

  let sev, col;
  if (!valid) { sev = '—'; col = '#475569'; }
  else if (score < 2.5) { sev = 'Minimal'; col = '#34d399'; }
  else if (score < 5) { sev = 'Mild'; col = '#fbbf24'; }
  else if (score < 7.5) { sev = 'Moderate'; col = '#f97316'; }
  else { sev = 'Severe'; col = '#ef4444'; }
  sevEl.textContent = sev;
  sevEl.style.color = col;

  if (!valid) return;

  // Gauge arc: center=(110,120), r=85, sweep from ~210° to ~330° (total 140°)
  const cx = 110, cy = 120, r = 85;
  const startDeg = 210, totalSpan = 140;
  const fraction = Math.min(Math.max(score / 10, 0), 1);
  const endDeg = startDeg + fraction * totalSpan;

  function pt(deg) {
    const rad = (deg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  const [sx, sy] = pt(startDeg);
  const [ex, ey] = pt(endDeg);
  const la = fraction * totalSpan > 180 ? 1 : 0;
  arcEl.setAttribute('d', `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${la} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`);

  // GSAP needle tween
  const needleRot = -90 + fraction * 140;
  gsap.to(needle, { rotate: needleRot, duration: 0.7, ease: 'elastic.out(1,0.75)', transformOrigin: '110px 120px' });
}

/* ═══════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════ */
function log(msg) {
  const el = document.getElementById('eventLog');
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.innerHTML += `<span style="color:rgba(255,255,255,0.2)">[${ts}]</span> ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setStatus(state, text) {
  const pill = document.getElementById('statusPill');
  pill.className = 'status-chip ' + state + ' flex items-center gap-1.5 self-start px-3 py-1 rounded-full text-[11px] font-semibold mb-1';
  document.getElementById('statusText').textContent = text;
  document.body.className = state === 'recording' ? 'recording' : '';

  const live = document.getElementById('liveIndicator');
  if (live) live.style.opacity = state !== 'disconnected' ? '1' : '0.5';
}

function pushWave(score) {
  waveBuffer[waveIdx % WAVE_LEN] = score;
  waveIdx++;
  if (!waveChart) return;
  const start = waveIdx % WAVE_LEN;
  waveChart.data.datasets[0].data = [...waveBuffer.slice(start), ...waveBuffer.slice(0, start)];
  waveChart.update('none');

  sparkBuffer.push(score);
  if (sparkBuffer.length > 22) sparkBuffer.shift();
  if (sparkChart) {
    sparkChart.data.labels = sparkBuffer.map((_, i) => i);
    sparkChart.data.datasets[0].data = sparkBuffer;
    sparkChart.update('none');
  }
}

function updateTrend() {
  if (!trendChart || !sessionWindows.length) return;
  const step = Math.max(1, Math.floor(sessionWindows.length / 55));
  const pts = sessionWindows.filter((_, i) => i % step === 0).map(w => w.score);
  trendChart.data.labels = pts.map((_, i) => i);
  trendChart.data.datasets[0].data = pts;
  trendChart.update('none');

  const badge = document.getElementById('trendBadge');
  if (badge && pts.length >= 4) {
    const half = Math.floor(pts.length / 2);
    const early = pts.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const late = pts.slice(half).reduce((a, b) => a + b, 0) / (pts.length - half);
    const d = late - early;
    badge.textContent = (d >= 0 ? '▲ +' : '▼ ') + d.toFixed(2);
    badge.style.color = d > 0.5 ? '#ef4444' : d < -0.5 ? '#34d399' : '#64748b';
  }
}

/* ═══════════════════════════════════════════════════
   CONNECT (ESP32)
═══════════════════════════════════════════════════ */
function connectESP() {
  const ip = document.getElementById('espIP').value.trim();
  if (!ip) { log('<span style="color:#fb7185">⚠ Enter TremorSense IP address</span>'); return; }
  if (sse) { sse.close(); sse = null; }

  const url = `http://${ip}/events`;
  log(`Connecting → <span style="color:#a78bfa">${url}</span>`);
  setStatus('disconnected', 'Connecting…');

  try { sse = new EventSource(url); }
  catch (e) { log(`<span style="color:#fb7185">Failed: ${e.message}</span>`); return; }

  sse.onopen = () => {
    setStatus('connected', 'Connected');
    log('<span style="color:#34d399">✓ SSE stream established</span>');
    document.getElementById('btnStart').disabled = false;
    gsap.fromTo('#btnStart', { scale: 1.06 }, { scale: 1, duration: 0.35, ease: 'back.out(2)' });
  };

  sse.onerror = () => {
    setStatus('disconnected', 'Disconnected');
    log('<span style="color:#fb7185">✗ Connection lost</span>');
    document.getElementById('btnStart').disabled = true;
  };

  sse.addEventListener('bands', e => {
    const j = JSON.parse(e.data);
    updateLiveDisplay(j);
    pushWave(j.score);
    if (sessionActive) {
      sessionWindows.push({ b1: j.b1, b2: j.b2, b3: j.b3, score: j.score, type: j.type || '', confidence: j.confidence || 0, meanNorm: j.meanNorm || 0, ts: Date.now() });
      updateSessionSummary();
      updateTrend();
    }
  });

  sse.addEventListener('calibrated', e => {
    const j = JSON.parse(e.data);
    calibratedNoiseFloor = j.baseline;
    log(`<span style="color:#2dd4bf">⚖ Calibrated — noise floor: ${j.baseline.toFixed(4)}</span>`);
  });
}

/* ═══════════════════════════════════════════════════
   LIVE DISPLAY UPDATE
═══════════════════════════════════════════════════ */
function updateLiveDisplay(j) {
  const { b1, b2, b3, score, type } = j;
  const total = b1 + b2 + b3 || 1;

  // Score vital
  const scoreEl = document.getElementById('liveScore');
  scoreEl.textContent = score.toFixed(2);
  if (score < 2.5) { scoreEl.style.color = '#2dd4bf'; scoreEl.style.textShadow = '0 0 20px rgba(45,212,191,0.4)'; }
  else if (score < 5) { scoreEl.style.color = '#fbbf24'; scoreEl.style.textShadow = '0 0 20px rgba(251,191,36,0.4)'; }
  else if (score < 7.5) { scoreEl.style.color = '#fb7185'; scoreEl.style.textShadow = '0 0 20px rgba(251,113,133,0.4)'; }
  else { scoreEl.style.color = '#ef4444'; scoreEl.style.textShadow = '0 0 20px rgba(239,68,68,0.5)'; }

  // Gauge
  updateGauge(score);

  // Classification
  document.getElementById('liveClass').textContent = type || '—';

  // Chart overlay badge
  document.getElementById('chartScore').textContent = 'SCORE ' + score.toFixed(2);

  // Bands
  const p1 = b1 / total * 100, p2 = b2 / total * 100, p3 = b3 / total * 100;
  document.getElementById('bar1').style.width = Math.min(p1, 100) + '%';
  document.getElementById('bar2').style.width = Math.min(p2, 100) + '%';
  document.getElementById('bar3').style.width = Math.min(p3, 100) + '%';
  document.getElementById('pct1').textContent = p1.toFixed(0) + '%';
  document.getElementById('pct2').textContent = p2.toFixed(0) + '%';
  document.getElementById('pct3').textContent = p3.toFixed(0) + '%';
}

/* ═══════════════════════════════════════════════════
   SESSION CONTROL
═══════════════════════════════════════════════════ */
function startSession() {
  sessionWindows = [];
  sessionStartTime = Date.now();
  sessionActive = true;
  setStatus('recording', 'Recording');
  document.getElementById('btnStart').disabled = true;
  document.getElementById('btnStop').disabled = false;
  document.getElementById('btnAnalyze').disabled = true;
  document.getElementById('windowCount').textContent = '0';
  document.getElementById('sessionDur').textContent = '0s';
  log('<span style="color:#fbbf24">▶ Session started — accumulating…</span>');
  startTimer();
  if (trendChart) { trendChart.data.labels = []; trendChart.data.datasets[0].data = []; trendChart.update('none'); }
  gsap.fromTo('#btnStop', { scale: 0.9, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: 'back.out(2)' });
}

function stopSession() {
  sessionActive = false;
  setStatus('connected', 'Connected');
  document.getElementById('btnStart').disabled = false;
  document.getElementById('btnStop').disabled = true;
  document.getElementById('btnAnalyze').disabled = sessionWindows.length < 3;
  log(`<span style="color:#34d399">⏹ Stopped — ${sessionWindows.length} windows captured</span>`);
  updateSessionSummary();
  updateTrend();
  if (sessionWindows.length >= 3) {
    gsap.fromTo('#btnAnalyze', { scale: 1.08, boxShadow: '0 0 30px rgba(139,92,246,0.5)' }, { scale: 1, boxShadow: '0 0 18px rgba(139,92,246,0.1)', duration: 0.6, ease: 'power3.out' });
  }
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!sessionActive) { clearInterval(timerInterval); return; }
    const dur = ((Date.now() - sessionStartTime) / 1000).toFixed(0);
    document.getElementById('sessionDur').textContent = dur + 's';
    document.getElementById('windowCount').textContent = sessionWindows.length;
  }, 500);
}

/* ═══════════════════════════════════════════════════
   SESSION SUMMARY
═══════════════════════════════════════════════════ */
function updateSessionSummary() {
  const W = sessionWindows;
  if (!W.length) return;
  const scores = W.map(w => w.score);
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(scores.reduce((a, s) => a + (s - mean) ** 2, 0) / n);

  document.getElementById('liveAvg').textContent = mean.toFixed(2);
  document.getElementById('livePeak').textContent = Math.max(...scores).toFixed(2);
  document.getElementById('sumMean').textContent = mean.toFixed(2);
  document.getElementById('sumStd').textContent = std.toFixed(2);

  const b1t = W.reduce((a, w) => a + w.b1, 0);
  const b2t = W.reduce((a, w) => a + w.b2, 0);
  const b3t = W.reduce((a, w) => a + w.b3, 0);
  document.getElementById('sumDom').textContent = b1t >= b2t && b1t >= b3t ? '4–6 Hz' : b2t >= b3t ? '6–8 Hz' : '8–12 Hz';

  const low = scores.filter(s => s < 2.5).length / n;
  const mod = scores.filter(s => s >= 2.5 && s < 5).length / n;
  const high = scores.filter(s => s >= 5 && s < 7.5).length / n;
  const vhigh = scores.filter(s => s >= 7.5).length / n;
  document.getElementById('distLow').textContent = (low * 100).toFixed(0) + '%';
  document.getElementById('distMod').textContent = (mod * 100).toFixed(0) + '%';
  document.getElementById('distHigh').textContent = (high * 100).toFixed(0) + '%';
  document.getElementById('distVHigh').textContent = (vhigh * 100).toFixed(0) + '%';

  if (distChart) {
    distChart.data.datasets[0].data = [Math.max(low, 0.001), Math.max(mod, 0.001), Math.max(high, 0.001), Math.max(vhigh, 0.001)];
    distChart.update();
  }
}

/* ═══════════════════════════════════════════════════
   BUILD SESSION SUMMARY (for backend)
═══════════════════════════════════════════════════ */
function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function buildSessionSummary() {
  const W = sessionWindows;
  if (W.length < 3) return null;

  const scores = W.map(w => w.score), n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(scores.reduce((a, s) => a + (s - mean) ** 2, 0) / n);
  const b1s = W.map(w => w.b1), b2s = W.map(w => w.b2), b3s = W.map(w => w.b3);
  const b1m = b1s.reduce((a, b) => a + b, 0) / n, b2m = b2s.reduce((a, b) => a + b, 0) / n, b3m = b3s.reduce((a, b) => a + b, 0) / n;
  const b1std = Math.sqrt(b1s.reduce((a, v) => a + (v - b1m) ** 2, 0) / n);
  const b2std = Math.sqrt(b2s.reduce((a, v) => a + (v - b2m) ** 2, 0) / n);
  const b3std = Math.sqrt(b3s.reduce((a, v) => a + (v - b3m) ** 2, 0) / n);
  const totBand = b1m + b2m + b3m;
  const domBand = b1m >= b2m && b1m >= b3m ? '4_6_hz' : b2m >= b3m ? '6_8_hz' : '8_12_hz';
  const domPct = Math.max(b1m, b2m, b3m) / (totBand || 1);
  const domRatio = Math.max(b1m, b2m, b3m) / (Math.min(b1m, b2m, b3m) || 0.001);
  let switches = 0;
  for (let i = 1; i < W.length; i++) {
    const prev = W[i - 1].b1 >= W[i - 1].b2 && W[i - 1].b1 >= W[i - 1].b3 ? 1 : W[i - 1].b2 >= W[i - 1].b3 ? 2 : 3;
    const cur = W[i].b1 >= W[i].b2 && W[i].b1 >= W[i].b3 ? 1 : W[i].b2 >= W[i].b3 ? 2 : 3;
    if (prev !== cur) switches++;
  }
  const pBands = [b1m, b2m, b3m].map(v => v / (totBand || 1));
  const spectralEntropy = +(-(pBands.reduce((s, p) => p > 0 ? s + p * Math.log2(p) : s, 0)) / Math.log2(3)).toFixed(4);
  const low = scores.filter(s => s < 2.5).length / n, moderate = scores.filter(s => s >= 2.5 && s < 5).length / n;
  const high = scores.filter(s => s >= 5 && s < 7.5).length / n, vhigh = scores.filter(s => s >= 7.5).length / n;
  const cv = std / (mean || 1), stability = 1 - cv;
  let wtwVar = 0; for (let i = 1; i < scores.length; i++) wtwVar += (scores[i] - scores[i - 1]) ** 2; wtwVar /= (n - 1);
  const durMin = (W[W.length - 1].ts - W[0].ts) / 60000;
  const xMean = (n - 1) / 2; let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xMean) * (scores[i] - mean); den += (i - xMean) ** 2; }
  const slopePerMin = durMin > 0 ? ((den ? num / den : 0) * n) / durMin : 0;
  const halfN = Math.floor(n / 2);
  const earlyAvg = scores.slice(0, halfN).reduce((a, b) => a + b, 0) / halfN;
  const lateAvg = scores.slice(halfN).reduce((a, b) => a + b, 0) / (n - halfN);
  const earlyLateChange = earlyAvg ? ((lateAvg - earlyAvg) / earlyAvg) * 100 : 0;
  const rmsMean = W.map(w => w.meanNorm || 0).reduce((a, b) => a + b, 0) / n;
  const recent = sessionHistory.slice(-2);
  const all = [...recent, { domBand, meanScore: mean, ts: W[W.length - 1].ts }];
  const domLabel = domBand.replace(/_/g, '–').replace('hz', ' Hz');
  const consistency = `${domLabel} in ${all.filter(s => s.domBand === domBand).length}/${all.length} sessions`;
  let weeklySlope = '+0.0';
  if (all.length >= 2) {
    const ms = all.map(s => s.meanScore), mt = all.map(s => s.ts);
    const tm = mt.reduce((a, b) => a + b) / mt.length, sm = ms.reduce((a, b) => a + b) / ms.length;
    let n2 = 0, d2 = 0; mt.forEach((t, i) => { n2 += (t - tm) * (ms[i] - sm); d2 += (t - tm) ** 2; });
    weeklySlope = ((d2 ? n2 / d2 : 0) * 604800000 >= 0 ? '+' : '') + ((d2 ? n2 / d2 : 0) * 604800000).toFixed(2);
  }
  let severityChangePct = 'N/A (first session)';
  if (recent.length) { const o = recent[0].meanScore, c = o > 0 ? ((mean - o) / o) * 100 : 0; severityChangePct = (c >= 0 ? '+' : '') + c.toFixed(1) + '%'; }
  const bandShift = recent.length > 0 && recent[recent.length - 1].domBand !== domBand;

  return {
    metadata: { session_id: 'S' + Date.now().toString().slice(-4), timestamp: new Date().toISOString(), duration_minutes: +durMin.toFixed(2), sampling_rate_hz: 50, condition: 'rest', medication_status: 'unknown', tremor_score_scale: '0_to_10_log_scaled' },
    frequency_profile: { band_power_mean: { hz_4_6: +b1m.toFixed(3), hz_6_8: +b2m.toFixed(3), hz_8_12: +b3m.toFixed(3) }, band_power_std: { hz_4_6: +b1std.toFixed(3), hz_6_8: +b2std.toFixed(3), hz_8_12: +b3std.toFixed(3) }, dominant_band: domBand, dominance_ratio: +domRatio.toFixed(2), dominant_band_percentage: +domPct.toFixed(3), band_switch_count: switches },
    intensity_profile: { tremor_score: { mean: +mean.toFixed(2), std: +std.toFixed(2), min: +Math.min(...scores).toFixed(2), max: +Math.max(...scores).toFixed(2), p25: +percentile(scores, 25).toFixed(2), p50: +percentile(scores, 50).toFixed(2), p75: +percentile(scores, 75).toFixed(2), p90: +percentile(scores, 90).toFixed(2) }, rms_mean: +rmsMean.toFixed(3), noise_floor_adjusted_intensity: calibratedNoiseFloor != null ? +Math.max(0, rmsMean - calibratedNoiseFloor).toFixed(3) : +(rmsMean * 0.93).toFixed(3) },
    intensity_distribution: { low_fraction: +low.toFixed(3), moderate_fraction: +moderate.toFixed(3), high_fraction: +high.toFixed(3), very_high_fraction: +vhigh.toFixed(3) },
    variability_profile: { coefficient_of_variation: +cv.toFixed(3), stability_index: +Math.max(0, stability).toFixed(3), spectral_entropy, window_to_window_variance: +wtwVar.toFixed(3) },
    within_session_trend: { linear_slope_per_minute_score_units: +slopePerMin.toFixed(4), early_vs_late_change_percent: +earlyLateChange.toFixed(1), fatigue_pattern_detected: earlyLateChange > 5 },
    multi_session_trend: { dominant_band_consistency_last_3: consistency, tremor_score_weekly_slope: weeklySlope, severity_change_percent: severityChangePct, band_shift_detected: bandShift }
  };
}

/* ═══════════════════════════════════════════════════
   GENERATE AI REPORT
═══════════════════════════════════════════════════ */
async function generateReport() {
  const btn = document.getElementById('btnAnalyze');
  const ph = document.getElementById('aiPlaceholder');
  const result = document.getElementById('aiResult');
  const content = document.getElementById('aiContent');
  const confEl = document.getElementById('aiConfidence');
  const advEl = document.getElementById('aiAdvisory');

  const summary = buildSessionSummary();
  if (!summary) { alert('Need at least 3 data windows.'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="ai-spinner"></span> Analyzing…';
  gsap.to(ph, { opacity: 0, y: -10, duration: 0.3, onComplete: () => ph.style.display = 'none' });
  result.style.display = 'flex';
  gsap.fromTo(result, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 });
  content.innerHTML = '<p style="color:#475569;font-size:13px">Generating clinical report via MedGemma 4B…</p>';
  confEl.innerHTML = ''; advEl.innerText = '';
  log('<span style="color:#a78bfa">🧠 Sending to backend for AI analysis…</span>');

  try {
    const resp = await fetch(BACKEND_URL + '/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();

    content.innerHTML = data.clinical_summary
      .replace(/## (.+)/g, '<h3>$1</h3>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');

    const cl = data.confidence_level.toLowerCase();
    confEl.className = 'ai-confidence-chip ' + cl;
    confEl.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg> Confidence: ${data.confidence_level}`;
    advEl.innerText = '⚠️ ' + data.advisory_note;

    // Persist this session + AI interpretation into local SQLite profile store.
    // This enables the longitudinal trends screen (profiles.html).
    try {
      await fetch(BACKEND_URL + '/profile/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: summary,
          clinical_summary: data.clinical_summary,
          confidence_level: data.confidence_level
        })
      });
    } catch (e) {
      console.warn('Failed to store session in local profile DB', e);
    }

    sessionHistory.push({ domBand: summary.frequency_profile.dominant_band, meanScore: summary.intensity_profile.tremor_score.mean, ts: Date.now() });
    if (sessionHistory.length > 10) sessionHistory.shift();
    localStorage.setItem('tremorSessionHistory', JSON.stringify(sessionHistory));
    log('<span style="color:#34d399">✓ AI report generated</span>');
  } catch (err) {
    content.innerHTML = `<p style="color:#fb7185">❌ ${err.message}</p><p style="color:#475569;margin-top:8px">Ensure backend is running at ${BACKEND_URL}</p>`;
    log(`<span style="color:#fb7185">✗ ${err.message}</span>`);
  }
  btn.disabled = false;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg> Generate AI Report`;
}

/* ═══════════════════════════════════════════════════
   GSAP ENTRANCE ANIMATIONS
═══════════════════════════════════════════════════ */
function runEntranceAnimations() {
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });

  // Sidebar → slides from left
  tl.fromTo('#sidebar',
    { x: -40, opacity: 0 },
    { x: 0, opacity: 1, duration: 0.65 }
  );

  // Topbar → drops from top
  tl.fromTo('#topbar',
    { y: -24, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.5 },
    '-=0.35'
  );

  // Vitals strip → staggered cascade
  tl.fromTo('#vitalsStrip > div',
    { opacity: 0, y: 16, scale: 0.96 },
    { opacity: 1, y: 0, scale: 1, duration: 0.5, stagger: 0.08, ease: 'back.out(1.5)' },
    '-=0.25'
  );

  // Dashboard panels → staggered fade-up
  tl.fromTo('.fade-item',
    { opacity: 0, y: 22 },
    { opacity: 1, y: 0, duration: 0.6, stagger: 0.09 },
    '-=0.25'
  );

  // Ambient glow orbs → fade in slowly
  gsap.fromTo('.glow-orb', { opacity: 0 }, { opacity: 1, duration: 2, stagger: 0.3, ease: 'power2.out' });

  // Gauge init
  updateGauge(NaN);

  // Pulse the AI orb
  gsap.to('.ai-orb', { y: -8, duration: 4, repeat: -1, yoyo: true, ease: 'sine.inOut' });

  // Hover glow on vital cards (GSAP)
  document.querySelectorAll('.vital-card').forEach(card => {
    card.addEventListener('mouseenter', () => gsap.to(card, { borderColor: 'rgba(255,255,255,0.14)', y: -3, duration: 0.25 }));
    card.addEventListener('mouseleave', () => gsap.to(card, { borderColor: 'rgba(255,255,255,0.06)', y: 0, duration: 0.3 }));
  });

  // Hover glow on panels
  document.querySelectorAll('.panel-card').forEach(card => {
    card.addEventListener('mouseenter', () => gsap.to(card, { borderColor: 'rgba(255,255,255,0.12)', duration: 0.25 }));
    card.addEventListener('mouseleave', () => gsap.to(card, { borderColor: 'rgba(255,255,255,0.06)', duration: 0.3 }));
  });
}

/* ═══════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Expose functions to HTML onclick= attributes (ES module scope workaround)
  Object.assign(window, { connectESP, startSession, stopSession, generateReport });

  initWaveChart();
  initSparkline();
  initTrendChart();
  initDistChart();
  runEntranceAnimations();
  log('TremorSense AI <span style="color:#a78bfa">v2.1 ready</span> — npm Tailwind + GSAP');
});
