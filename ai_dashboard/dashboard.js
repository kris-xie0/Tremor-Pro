/* ═══════════════════════════════════════
   STATE
═══════════════════════════════════════ */
let sse = null;
let sessionActive = false;
let sessionWindows = [];
let sessionStartTime = 0;
let calibratedNoiseFloor = null;
let timerInterval = null;
let sessionHistory = JSON.parse(localStorage.getItem('tremorSessionHistory') || '[]');

const BACKEND_URL = window.location.origin;

/* ── Waveform ring buffer ── */
const WAVE_LEN = 80;
const waveBuffer = new Array(WAVE_LEN).fill(null);
let waveIdx = 0;

/* ═══════════════════════════════════════
   CHART.JS – LIVE WAVEFORM
═══════════════════════════════════════ */
let waveChart = null;

function initChart() {
  const ctx = document.getElementById('waveCanvas').getContext('2d');
  const labels = Array.from({length: WAVE_LEN}, (_, i) => i);

  const grad = ctx.createLinearGradient(0, 0, 0, 180);
  grad.addColorStop(0, 'rgba(99,102,241,0.35)');
  grad.addColorStop(1, 'rgba(99,102,241,0)');

  waveChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: new Array(WAVE_LEN).fill(null),
        borderColor: '#6366f1',
        borderWidth: 2,
        backgroundColor: grad,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        spanGaps: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: {
          display: true,
          min: 0, max: 10,
          grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
          ticks: {
            color: 'rgba(255,255,255,0.2)', font: { size: 10, family: 'JetBrains Mono' },
            maxTicksLimit: 5, stepSize: 2.5
          }
        }
      }
    }
  });
}

/* ── Trend sparkline ── */
let trendChart = null;

function initTrendChart() {
  const ctx = document.getElementById('trendCanvas').getContext('2d');
  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: '#22d3ee',
        borderWidth: 1.5,
        backgroundColor: 'rgba(34,211,238,0.08)',
        fill: true,
        tension: 0.4,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend:{display:false}, tooltip:{enabled:false} },
      scales: {
        x: { display:false },
        y: { display:false, min:0, max:10 }
      }
    }
  });
}

/* ═══════════════════════════════════════
   HELPERS
═══════════════════════════════════════ */
function log(msg) {
  const el = document.getElementById('eventLog');
  const ts = new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  el.innerHTML += `<span class="ts">[${ts}]</span> ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setStatus(state, text) {
  const pill = document.getElementById('statusPill');
  const label = document.getElementById('statusText');
  pill.className = 'status-pill ' + state;
  label.textContent = text;
  document.body.className = state === 'recording' ? 'recording' : '';
}

function pushWave(score) {
  waveBuffer[waveIdx % WAVE_LEN] = score;
  waveIdx++;
  if (!waveChart) return;
  // Rotate so oldest is first
  const start = waveIdx % WAVE_LEN;
  const data = [...waveBuffer.slice(start), ...waveBuffer.slice(0, start)];
  waveChart.data.datasets[0].data = data;
  waveChart.update('none');
}

function updateTrend() {
  if (!trendChart || sessionWindows.length === 0) return;
  // Sample every Nth window for trend
  const step = Math.max(1, Math.floor(sessionWindows.length / 40));
  const pts = sessionWindows.filter((_, i) => i % step === 0).map(w => w.score);
  trendChart.data.labels = pts.map((_, i) => i);
  trendChart.data.datasets[0].data = pts;
  trendChart.update('none');
}

/* ═══════════════════════════════════════
   CONNECT
═══════════════════════════════════════ */
function connectESP() {
  const ip = document.getElementById('espIP').value.trim();
  if (!ip) { log('<span style="color:#ef4444">⚠ Enter TremorSense IP address</span>'); return; }
  if (sse) { sse.close(); sse = null; }

  const url = `http://${ip}/events`;
  log(`Connecting → <span style="color:#6366f1">${url}</span>`);
  setStatus('disconnected', 'Connecting…');

  try { sse = new EventSource(url); }
  catch(e) { log(`<span style="color:#ef4444">Failed: ${e.message}</span>`); return; }

  sse.onopen = () => {
    setStatus('connected','Connected');
    log('<span style="color:#10b981">✓ SSE stream established</span>');
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnConnect').innerHTML = `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 4l16 16M4 20L20 4"/></svg> Reconnect`;
  };

  sse.onerror = () => {
    setStatus('disconnected','Disconnected');
    log('<span style="color:#ef4444">✗ Connection lost</span>');
    document.getElementById('btnStart').disabled = true;
  };

  sse.addEventListener('bands', e => {
    const j = JSON.parse(e.data);
    updateLiveDisplay(j);
    pushWave(j.score);
    if (sessionActive) {
      sessionWindows.push({ b1:j.b1, b2:j.b2, b3:j.b3, score:j.score,
        type:j.type||'', confidence:j.confidence||0, meanNorm:j.meanNorm||0, ts:Date.now() });
      updateSessionSummary();
      updateTrend();
    }
  });

  sse.addEventListener('calibrated', e => {
    const j = JSON.parse(e.data);
    calibratedNoiseFloor = j.baseline;
    log(`<span style="color:#22d3ee">⚖ Calibrated — noise floor: ${j.baseline.toFixed(4)}</span>`);
  });
}

/* ═══════════════════════════════════════
   LIVE DISPLAY
═══════════════════════════════════════ */
function updateLiveDisplay(j) {
  const {b1,b2,b3,score,type} = j;
  const total = b1+b2+b3 || 1;

  document.getElementById('liveScore').textContent = score.toFixed(2);
  // colorize score
  const scoreEl = document.getElementById('liveScore');
  scoreEl.className = 'stat-value ' + (score<2.5?'c-green':score<5?'c-yellow':score<7.5?'c-orange':'c-red');
  document.getElementById('liveClass').textContent = type || '—';

  const p1=(b1/total*100), p2=(b2/total*100), p3=(b3/total*100);
  document.getElementById('bar1').style.width = Math.min(p1,100)+'%';
  document.getElementById('bar2').style.width = Math.min(p2,100)+'%';
  document.getElementById('bar3').style.width = Math.min(p3,100)+'%';
  document.getElementById('pct1').textContent = p1.toFixed(0)+'%';
  document.getElementById('pct2').textContent = p2.toFixed(0)+'%';
  document.getElementById('pct3').textContent = p3.toFixed(0)+'%';

  // live chart overlay
  document.getElementById('chartScore').textContent = score.toFixed(2);
}

/* ═══════════════════════════════════════
   SESSION CONTROL
═══════════════════════════════════════ */
function startSession() {
  sessionWindows = [];
  sessionStartTime = Date.now();
  sessionActive = true;
  setStatus('recording','Recording');
  document.getElementById('btnStart').disabled = true;
  document.getElementById('btnStop').disabled = false;
  document.getElementById('btnAnalyze').disabled = true;
  document.getElementById('windowCount').textContent = '0';
  document.getElementById('sessionDur').textContent = '0s';
  log('<span style="color:#f59e0b">▶ Session started — accumulating…</span>');
  startTimer();
  // clear trend
  if (trendChart) { trendChart.data.labels=[]; trendChart.data.datasets[0].data=[]; trendChart.update('none'); }
}

function stopSession() {
  sessionActive = false;
  setStatus('connected','Connected');
  document.getElementById('btnStart').disabled = false;
  document.getElementById('btnStop').disabled = true;
  document.getElementById('btnAnalyze').disabled = sessionWindows.length < 3;
  log(`<span style="color:#10b981">⏹ Stopped — ${sessionWindows.length} windows captured</span>`);
  updateSessionSummary();
  updateTrend();
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!sessionActive) { clearInterval(timerInterval); return; }
    const dur = ((Date.now()-sessionStartTime)/1000).toFixed(0);
    document.getElementById('sessionDur').textContent = dur+'s';
    document.getElementById('windowCount').textContent = sessionWindows.length;
  }, 500);
}

/* ═══════════════════════════════════════
   SESSION SUMMARY DISPLAY
═══════════════════════════════════════ */
function updateSessionSummary() {
  const W = sessionWindows;
  if(!W.length) return;
  const scores = W.map(w=>w.score);
  const n = scores.length;
  const mean = scores.reduce((a,b)=>a+b,0)/n;
  const std = Math.sqrt(scores.reduce((a,s)=>a+(s-mean)**2,0)/n);

  document.getElementById('liveAvg').textContent = mean.toFixed(2);
  document.getElementById('livePeak').textContent = Math.max(...scores).toFixed(2);
  document.getElementById('sumMean').textContent = mean.toFixed(2);
  document.getElementById('sumStd').textContent = std.toFixed(2);

  const b1t=W.reduce((a,w)=>a+w.b1,0), b2t=W.reduce((a,w)=>a+w.b2,0), b3t=W.reduce((a,w)=>a+w.b3,0);
  const dom = b1t>=b2t&&b1t>=b3t?'4–6 Hz':b2t>=b3t?'6–8 Hz':'8–12 Hz';
  document.getElementById('sumDom').textContent = dom;

  const low=scores.filter(s=>s<2.5).length/n;
  const mod=scores.filter(s=>s>=2.5&&s<5).length/n;
  const high=scores.filter(s=>s>=5&&s<7.5).length/n;
  const vhigh=scores.filter(s=>s>=7.5).length/n;
  document.getElementById('distLow').textContent = (low*100).toFixed(0)+'%';
  document.getElementById('distMod').textContent = (mod*100).toFixed(0)+'%';
  document.getElementById('distHigh').textContent = (high*100).toFixed(0)+'%';
  document.getElementById('distVHigh').textContent = (vhigh*100).toFixed(0)+'%';
}

/* ═══════════════════════════════════════
   BUILD SESSION SUMMARY (for backend)
═══════════════════════════════════════ */
function percentile(arr, p) {
  const sorted = [...arr].sort((a,b)=>a-b);
  const idx = (p/100)*(sorted.length-1);
  const lo=Math.floor(idx), hi=Math.ceil(idx);
  return lo===hi?sorted[lo]:sorted[lo]+(sorted[hi]-sorted[lo])*(idx-lo);
}

function buildSessionSummary() {
  const W = sessionWindows;
  if(W.length<3) return null;
  const scores=W.map(w=>w.score), n=scores.length;
  const mean=scores.reduce((a,b)=>a+b,0)/n;
  const std=Math.sqrt(scores.reduce((a,s)=>a+(s-mean)**2,0)/n);
  const b1s=W.map(w=>w.b1),b2s=W.map(w=>w.b2),b3s=W.map(w=>w.b3);
  const b1m=b1s.reduce((a,b)=>a+b,0)/n,b2m=b2s.reduce((a,b)=>a+b,0)/n,b3m=b3s.reduce((a,b)=>a+b,0)/n;
  const b1std=Math.sqrt(b1s.reduce((a,v)=>a+(v-b1m)**2,0)/n);
  const b2std=Math.sqrt(b2s.reduce((a,v)=>a+(v-b2m)**2,0)/n);
  const b3std=Math.sqrt(b3s.reduce((a,v)=>a+(v-b3m)**2,0)/n);
  const totBand=b1m+b2m+b3m;
  const domBand=b1m>=b2m&&b1m>=b3m?'4_6_hz':b2m>=b3m?'6_8_hz':'8_12_hz';
  const domPct=Math.max(b1m,b2m,b3m)/(totBand||1);
  const domRatio=Math.max(b1m,b2m,b3m)/(Math.min(b1m,b2m,b3m)||0.001);
  let switches=0;
  for(let i=1;i<W.length;i++){
    const prev=W[i-1].b1>=W[i-1].b2&&W[i-1].b1>=W[i-1].b3?1:W[i-1].b2>=W[i-1].b3?2:3;
    const cur=W[i].b1>=W[i].b2&&W[i].b1>=W[i].b3?1:W[i].b2>=W[i].b3?2:3;
    if(prev!==cur)switches++;
  }
  const pBands=[b1m,b2m,b3m].map(v=>v/(totBand||1));
  const spectralEntropy=+(-(pBands.reduce((s,p)=>p>0?s+p*Math.log2(p):s,0))/Math.log2(3)).toFixed(4);
  const low=scores.filter(s=>s<2.5).length/n,moderate=scores.filter(s=>s>=2.5&&s<5).length/n;
  const high=scores.filter(s=>s>=5&&s<7.5).length/n,vhigh=scores.filter(s=>s>=7.5).length/n;
  const cv=std/(mean||1),stability=1-cv;
  let wtwVar=0; for(let i=1;i<scores.length;i++) wtwVar+=(scores[i]-scores[i-1])**2;
  wtwVar/=(n-1);
  const durMin=(W[W.length-1].ts-W[0].ts)/60000;
  const xMean=(n-1)/2; let num=0,den=0;
  for(let i=0;i<n;i++){num+=(i-xMean)*(scores[i]-mean);den+=(i-xMean)**2;}
  const slopePerWindow=den?num/den:0;
  const slopePerMin=durMin>0?(slopePerWindow*n)/durMin:0;
  const halfN=Math.floor(n/2);
  const earlyAvg=scores.slice(0,halfN).reduce((a,b)=>a+b,0)/halfN;
  const lateAvg=scores.slice(halfN).reduce((a,b)=>a+b,0)/(n-halfN);
  const earlyLateChange=earlyAvg?((lateAvg-earlyAvg)/earlyAvg)*100:0;
  const rmsVals=W.map(w=>w.meanNorm||0);
  const rmsMean=rmsVals.reduce((a,b)=>a+b,0)/n;
  const recentSessions=sessionHistory.slice(-2);
  const allSess=[...recentSessions,{domBand,meanScore:mean,ts:W[W.length-1].ts}];
  const nSess=allSess.length;
  const domBandLabel=domBand.replace(/_/g,'–').replace('hz',' Hz');
  const domConsistencyCount=allSess.filter(s=>s.domBand===domBand).length;
  const consistencyStr=`${domBandLabel} in ${domConsistencyCount}/${nSess} sessions`;
  let weeklySlope='+0.0';
  if(allSess.length>=2){
    const mScores=allSess.map(s=>s.meanScore),mTs=allSess.map(s=>s.ts);
    const tsMean=mTs.reduce((a,b)=>a+b,0)/mTs.length,sMean2=mScores.reduce((a,b)=>a+b,0)/mScores.length;
    let num2=0,den2=0;
    mTs.forEach((t,i)=>{num2+=(t-tsMean)*(mScores[i]-sMean2);den2+=(t-tsMean)**2;});
    const slpPerWeek=(den2?num2/den2:0)*604800000;
    weeklySlope=(slpPerWeek>=0?'+':'')+slpPerWeek.toFixed(2);
  }
  let severityChangePct='N/A (first session)';
  if(recentSessions.length>=1){
    const oldest=recentSessions[0].meanScore,chg=oldest>0?((mean-oldest)/oldest)*100:0;
    severityChangePct=(chg>=0?'+':'')+chg.toFixed(1)+'%';
  }
  const bandShift=recentSessions.length>0&&recentSessions[recentSessions.length-1].domBand!==domBand;
  return {
    metadata:{session_id:'S'+Date.now().toString().slice(-4),timestamp:new Date().toISOString(),
      duration_minutes:+durMin.toFixed(2),sampling_rate_hz:50,condition:'rest',
      medication_status:'unknown',tremor_score_scale:'0_to_10_log_scaled'},
    frequency_profile:{band_power_mean:{hz_4_6:+b1m.toFixed(3),hz_6_8:+b2m.toFixed(3),hz_8_12:+b3m.toFixed(3)},
      band_power_std:{hz_4_6:+b1std.toFixed(3),hz_6_8:+b2std.toFixed(3),hz_8_12:+b3std.toFixed(3)},
      dominant_band:domBand,dominance_ratio:+domRatio.toFixed(2),
      dominant_band_percentage:+domPct.toFixed(3),band_switch_count:switches},
    intensity_profile:{tremor_score:{mean:+mean.toFixed(2),std:+std.toFixed(2),
      min:+Math.min(...scores).toFixed(2),max:+Math.max(...scores).toFixed(2),
      p25:+percentile(scores,25).toFixed(2),p50:+percentile(scores,50).toFixed(2),
      p75:+percentile(scores,75).toFixed(2),p90:+percentile(scores,90).toFixed(2)},
      rms_mean:+rmsMean.toFixed(3),
      noise_floor_adjusted_intensity:calibratedNoiseFloor!=null
        ?+Math.max(0,rmsMean-calibratedNoiseFloor).toFixed(3):+(rmsMean*0.93).toFixed(3)},
    intensity_distribution:{low_fraction:+low.toFixed(3),moderate_fraction:+moderate.toFixed(3),
      high_fraction:+high.toFixed(3),very_high_fraction:+vhigh.toFixed(3)},
    variability_profile:{coefficient_of_variation:+cv.toFixed(3),stability_index:+Math.max(0,stability).toFixed(3),
      spectral_entropy:spectralEntropy,window_to_window_variance:+wtwVar.toFixed(3)},
    within_session_trend:{linear_slope_per_minute_score_units:+slopePerMin.toFixed(4),
      early_vs_late_change_percent:+earlyLateChange.toFixed(1),fatigue_pattern_detected:earlyLateChange>5},
    multi_session_trend:{dominant_band_consistency_last_3:consistencyStr,
      tremor_score_weekly_slope:weeklySlope,severity_change_percent:severityChangePct,band_shift_detected:bandShift}
  };
}

/* ═══════════════════════════════════════
   GENERATE AI REPORT
═══════════════════════════════════════ */
async function generateReport() {
  const btn=document.getElementById('btnAnalyze');
  const placeholder=document.getElementById('aiPlaceholder');
  const result=document.getElementById('aiResult');
  const content=document.getElementById('aiContent');
  const confEl=document.getElementById('aiConfidence');
  const advEl=document.getElementById('aiAdvisory');

  const summary=buildSessionSummary();
  if(!summary){ alert('Need at least 3 data windows.'); return; }

  btn.disabled=true;
  btn.innerHTML='<span class="ai-spinner"></span> Analyzing…';
  placeholder.style.display='none';
  result.style.display='flex';
  content.innerHTML='<p style="color:#64748b;font-size:13px">Generating clinical report via MedGemma 4B…</p>';
  confEl.innerHTML=''; advEl.innerText='';
  log('<span style="color:#a78bfa">🧠 Sending to backend for AI analysis…</span>');

  try {
    const resp=await fetch(BACKEND_URL+'/analyze',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(summary)});
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const data=await resp.json();

    let html=data.clinical_summary
      .replace(/## (.+)/g,'<h3>$1</h3>')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\n/g,'<br>');
    content.innerHTML=html;

    const cl=data.confidence_level.toLowerCase();
    confEl.className='ai-confidence-chip '+cl;
    confEl.innerHTML=`<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg> Confidence: ${data.confidence_level}`;
    advEl.innerText='⚠️ '+data.advisory_note;

    sessionHistory.push({domBand:summary.frequency_profile.dominant_band,
      meanScore:summary.intensity_profile.tremor_score.mean,ts:Date.now()});
    if(sessionHistory.length>10)sessionHistory.shift();
    localStorage.setItem('tremorSessionHistory',JSON.stringify(sessionHistory));
    log('<span style="color:#10b981">✓ AI report generated</span>');
  } catch(err) {
    content.innerHTML=`<p style="color:#ef4444">❌ ${err.message}</p><p style="color:#64748b;margin-top:8px">Ensure backend is running at ${BACKEND_URL}</p>`;
    log(`<span style="color:#ef4444">✗ ${err.message}</span>`);
  }
  btn.disabled=false;
  btn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 8v4l3 3"/></svg> Generate AI Report';
}

/* ═══════════════════════════════════════
   GSAP ENTRANCE ANIMATIONS
═══════════════════════════════════════ */
function runEntranceAnimations() {
  gsap.fromTo('.fade-in', 
    { opacity:0, y:20 },
    { opacity:1, y:0, duration:.6, stagger:.08, ease:'power3.out', delay:.1 }
  );
  // header glow pulse
  gsap.to('#app-header', { boxShadow:'0 1px 0 0 rgba(99,102,241,0.3)', duration:1.5, repeat:-1, yoyo:true, ease:'sine.inOut' });
}

/* ═══════════════════════════════════════
   INIT
═══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  initTrendChart();
  runEntranceAnimations();
  log('TremorSense dashboard ready.');
});
