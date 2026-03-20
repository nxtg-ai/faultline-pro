/**
 * Analytics Dashboard routes (D-165)
 *
 * GET /analytics          — HTML dashboard (public)
 * GET /analytics/overview — aggregate JSON for all chart panels (public)
 */

import type { FastifyInstance } from 'fastify';
import { getScanHistory } from '../store/scan-history.js';
import { getScanCache } from '../store/cache.js';
import { getClaimIndex } from '../store/claims.js';

// ── Aggregation helpers ───────────────────────────────────────────────────────

const RISK_SCORE: Record<string, number> = {
  Low: 25, Medium: 50, High: 75, Critical: 100,
};

/** ISO date string → 'YYYY-MM-DD' */
function toDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Build an ordered array of the last N calendar days (YYYY-MM-DD). */
function lastNDays(n: number): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// ── Overview computation ──────────────────────────────────────────────────────

function computeOverview() {
  const DAYS = 30;
  const window = lastNDays(DAYS);
  const windowSet = new Set(window);

  const entries = getScanHistory().getRecent(1000);
  const inWindow = entries.filter(e => windowSet.has(toDay(e.timestamp)));

  // Scan volume per day
  const volumeMap = new Map<string, number>(window.map(d => [d, 0]));
  for (const e of inWindow) {
    const d = toDay(e.timestamp);
    volumeMap.set(d, (volumeMap.get(d) ?? 0) + 1);
  }
  const scanVolume = window.map(date => ({ date, count: volumeMap.get(date)! }));

  // Provider distribution (all history)
  const provMap = new Map<string, number>();
  for (const e of entries) {
    provMap.set(e.provider, (provMap.get(e.provider) ?? 0) + 1);
  }
  const providerDistribution = [...provMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([provider, count]) => ({ provider, count }));

  // Risk distribution per day (stacked) + trust score trend
  const riskDayMap = new Map<string, Record<string, number>>(
    window.map(d => [d, { Low: 0, Medium: 0, High: 0, Critical: 0 }]),
  );
  const scoreDayMap = new Map<string, number[]>(window.map(d => [d, []]));
  for (const e of inWindow) {
    const d = toDay(e.timestamp);
    const bucket = riskDayMap.get(d)!;
    const risk = e.overallRisk ?? 'Low';
    const label = risk.charAt(0).toUpperCase() + risk.slice(1).toLowerCase();
    const key = label in bucket ? label : 'Low';
    bucket[key]++;
    scoreDayMap.get(d)!.push(RISK_SCORE[key] ?? 25);
  }
  const riskTrend = window.map(date => ({ date, ...riskDayMap.get(date)! }));
  const trustTrend = window.map(date => {
    const scores = scoreDayMap.get(date)!;
    const avg = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
    return { date, avgTrustScore: avg !== null ? Math.round(avg) : null };
  });

  // Latency trend (avg ms per day)
  const latDayMap = new Map<string, number[]>(window.map(d => [d, []]));
  for (const e of inWindow) {
    if (typeof e.latencyMs === 'number') latDayMap.get(toDay(e.timestamp))!.push(e.latencyMs);
  }
  const latencyTrend = window.map(date => {
    const ms = latDayMap.get(date)!;
    return { date, avgMs: ms.length > 0 ? Math.round(ms.reduce((s, v) => s + v, 0) / ms.length) : null };
  });

  // Cache stats
  const cacheStats = getScanCache().stats();

  // Claim categories from ClaimIndex
  const claimStats = getClaimIndex().getStats();
  const claimCategories = Object.entries(claimStats.claimTypes)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));

  // Summary card
  const totalScans = entries.length;
  const avgClaims = entries.length > 0
    ? Math.round(entries.reduce((s, e) => s + e.claimCount, 0) / entries.length)
    : 0;
  const mostUsed = providerDistribution[0]?.provider ?? 'none';

  return {
    scanVolume,
    providerDistribution,
    riskTrend,
    trustTrend,
    latencyTrend,
    cacheStats: {
      size:    cacheStats.size,
      hits:    cacheStats.hits,
      misses:  cacheStats.misses,
      hitRate: Math.round(cacheStats.hitRate * 100),
    },
    claimCategories,
    summary: {
      totalScans,
      totalClaims:      claimStats.totalClaims,
      avgClaimsPerScan: avgClaims,
      mostUsedProvider: mostUsed,
      cacheHitRate:     Math.round(cacheStats.hitRate * 100),
      accuracyRate:     Math.round(claimStats.accuracyRate * 100),
    },
  };
}

// ── HTML builder ─────────────────────────────────────────────────────────────

function buildAnalyticsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Faultline Pro — Analytics</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  :root{--bg:#0f1117;--surface:#1a1d27;--surface2:#22263a;--border:#2d3148;--accent:#6c63ff;--accent2:#00c9a7;--warn:#f5a623;--danger:#e05c5c;--text:#e2e4f0;--text-muted:#7a7f99;--card-radius:12px}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:14px;min-height:100vh}
  header{padding:20px 32px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;background:var(--surface)}
  header h1{font-size:18px;font-weight:700;letter-spacing:-0.3px}
  header span.badge{background:var(--accent);color:#fff;font-size:11px;padding:2px 8px;border-radius:99px;font-weight:600}
  .subtitle{color:var(--text-muted);font-size:13px;margin-left:auto}
  main{padding:28px 32px;display:grid;gap:24px}
  .summary-row{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
  @media(max-width:1200px){.summary-row{grid-template-columns:repeat(3,1fr)}}
  @media(max-width:700px){.summary-row{grid-template-columns:repeat(2,1fr)}}
  .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--card-radius);padding:18px 20px}
  .stat-card .label{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px}
  .stat-card .value{font-size:28px;font-weight:700;line-height:1}
  .stat-card .sub{font-size:12px;color:var(--text-muted);margin-top:4px}
  .chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media(max-width:900px){.chart-grid{grid-template-columns:1fr}}
  .chart-grid.three{grid-template-columns:2fr 1fr}
  @media(max-width:900px){.chart-grid.three{grid-template-columns:1fr}}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--card-radius);padding:20px 24px}
  .card h2{font-size:13px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:16px}
  .card.full{grid-column:1/-1}
  canvas{display:block;width:100%!important}
  .cache-ring{display:flex;align-items:center;gap:32px;padding:8px 0}
  .ring-wrap{position:relative;width:130px;height:130px;flex-shrink:0}
  .ring-label{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
  .ring-label .pct{font-size:28px;font-weight:700}
  .ring-label .sub{font-size:11px;color:var(--text-muted)}
  .cache-stats{display:flex;flex-direction:column;gap:10px}
  .cache-row{display:flex;justify-content:space-between;gap:32px;font-size:13px}
  .cache-row span:first-child{color:var(--text-muted)}
  .cache-row span:last-child{font-weight:600}
  #loading{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:99;transition:opacity .3s}
  #loading.gone{opacity:0;pointer-events:none}
  .spinner{width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .accent{color:var(--accent)}
  .provider-pill{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-right:4px}
</style>
</head>
<body>
<div id="loading"><div class="spinner"></div></div>
<header>
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#6c63ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <h1>Faultline Pro <span class="badge">Analytics</span></h1>
  <span class="subtitle" id="ts">Loading…</span>
</header>
<main>
  <div class="summary-row" id="summary-row">
    <div class="stat-card"><div class="label">Total Scans</div><div class="value" id="s-scans">—</div><div class="sub">all time</div></div>
    <div class="stat-card"><div class="label">Total Claims</div><div class="value" id="s-claims">—</div><div class="sub">indexed</div></div>
    <div class="stat-card"><div class="label">Avg Claims/Scan</div><div class="value" id="s-avg">—</div><div class="sub">all time</div></div>
    <div class="stat-card"><div class="label">Cache Hit Rate</div><div class="value" id="s-cache">—<span style="font-size:16px">%</span></div><div class="sub">scan cache</div></div>
    <div class="stat-card"><div class="label">Accuracy Rate</div><div class="value" id="s-accuracy">—<span style="font-size:16px">%</span></div><div class="sub">supported / definitive</div></div>
    <div class="stat-card"><div class="label">Top Provider</div><div class="value" id="s-provider" style="font-size:20px;margin-top:2px">—</div><div class="sub">by scan volume</div></div>
  </div>

  <div class="chart-grid three">
    <div class="card full">
      <h2>Scan Volume — Last 30 Days</h2>
      <canvas id="chart-volume" height="80"></canvas>
    </div>
  </div>

  <div class="chart-grid">
    <div class="card">
      <h2>Trust Score Trend (Avg)</h2>
      <canvas id="chart-trust" height="140"></canvas>
    </div>
    <div class="card">
      <h2>Risk Distribution Over Time</h2>
      <canvas id="chart-risk" height="140"></canvas>
    </div>
  </div>

  <div class="chart-grid">
    <div class="card">
      <h2>Provider Usage</h2>
      <canvas id="chart-provider" height="180"></canvas>
    </div>
    <div class="card">
      <h2>Top Claim Categories</h2>
      <canvas id="chart-claims" height="180"></canvas>
    </div>
  </div>

  <div class="chart-grid three">
    <div class="card">
      <h2>Average Scan Latency (ms)</h2>
      <canvas id="chart-latency" height="100"></canvas>
    </div>
    <div class="card">
      <h2>Cache Performance</h2>
      <div class="cache-ring">
        <div class="ring-wrap">
          <canvas id="chart-cache"></canvas>
          <div class="ring-label"><span class="pct" id="cache-pct">—</span><span class="sub">hit rate</span></div>
        </div>
        <div class="cache-stats" id="cache-stats">
          <div class="cache-row"><span>Cache size</span><span id="c-size">—</span></div>
          <div class="cache-row"><span>Cache hits</span><span id="c-hits">—</span></div>
          <div class="cache-row"><span>Cache misses</span><span id="c-misses">—</span></div>
          <div class="cache-row"><span>Hit rate</span><span id="c-rate">—</span></div>
        </div>
      </div>
    </div>
  </div>
</main>

<script>
const ACCENT   = '#6c63ff';
const ACCENT2  = '#00c9a7';
const WARN     = '#f5a623';
const DANGER   = '#e05c5c';
const MUTED    = '#7a7f99';
const SURFACE  = '#22263a';
const RISK_COLORS = { Low: '#00c9a7', Medium: WARN, High: '#f97316', Critical: DANGER };
const PROVIDER_COLORS = ['#6c63ff','#00c9a7','#f5a623','#e05c5c','#818cf8','#34d399'];

function fmt(n){ return n == null ? '—' : n.toLocaleString(); }

const baseChartOpts = {
  responsive:true, maintainAspectRatio:true,
  plugins:{ legend:{ labels:{ color:'#7a7f99', boxWidth:12, font:{size:12} } } },
  scales:{
    x:{ ticks:{ color:MUTED, maxRotation:0, font:{size:11} }, grid:{ color:'#1e2238' } },
    y:{ ticks:{ color:MUTED, font:{size:11} }, grid:{ color:'#1e2238' } },
  },
};

async function load(){
  const data = await fetch('/analytics/overview').then(r=>r.json());

  // Summary cards
  document.getElementById('s-scans').textContent    = fmt(data.summary.totalScans);
  document.getElementById('s-claims').textContent   = fmt(data.summary.totalClaims);
  document.getElementById('s-avg').textContent      = fmt(data.summary.avgClaimsPerScan);
  document.getElementById('s-cache').innerHTML      = data.summary.cacheHitRate+'<span style="font-size:16px">%</span>';
  document.getElementById('s-accuracy').innerHTML   = data.summary.accuracyRate+'<span style="font-size:16px">%</span>';
  document.getElementById('s-provider').textContent = data.summary.mostUsedProvider || '—';
  document.getElementById('ts').textContent         = 'Last updated ' + new Date().toLocaleTimeString();

  const labels30 = data.scanVolume.map(d=>d.date.slice(5)); // MM-DD

  // Volume chart
  new Chart(document.getElementById('chart-volume'), {
    type:'line',
    data:{
      labels: labels30,
      datasets:[{
        label:'Scans', data: data.scanVolume.map(d=>d.count),
        borderColor:ACCENT, backgroundColor:'rgba(108,99,255,.12)',
        fill:true, tension:.35, pointRadius:3, pointHoverRadius:5,
      }],
    },
    options:{...baseChartOpts, plugins:{ legend:{ display:false } }},
  });

  // Trust score trend
  const trustPoints = data.trustTrend.map(d=>d.avgTrustScore);
  new Chart(document.getElementById('chart-trust'),{
    type:'line',
    data:{
      labels: labels30,
      datasets:[{
        label:'Avg Trust Score', data: trustPoints,
        borderColor:ACCENT2, backgroundColor:'rgba(0,201,167,.1)',
        fill:true, tension:.35, pointRadius:3, spanGaps:true,
      }],
    },
    options:{
      ...baseChartOpts,
      scales:{
        ...baseChartOpts.scales,
        y:{ ...baseChartOpts.scales.y, min:0, max:100,
            ticks:{ ...baseChartOpts.scales.y.ticks,
              callback:(v)=>v+' pts' } },
      },
    },
  });

  // Stacked risk trend
  new Chart(document.getElementById('chart-risk'),{
    type:'bar',
    data:{
      labels: labels30,
      datasets: ['Low','Medium','High','Critical'].map(risk=>({
        label:risk, data: data.riskTrend.map(d=>d[risk]||0),
        backgroundColor:RISK_COLORS[risk], stack:'risk',
      })),
    },
    options:{...baseChartOpts, scales:{
      x:{...baseChartOpts.scales.x, stacked:true},
      y:{...baseChartOpts.scales.y, stacked:true},
    }},
  });

  // Provider doughnut
  new Chart(document.getElementById('chart-provider'),{
    type:'doughnut',
    data:{
      labels: data.providerDistribution.map(p=>p.provider),
      datasets:[{
        data: data.providerDistribution.map(p=>p.count),
        backgroundColor: PROVIDER_COLORS,
        borderColor: '#0f1117', borderWidth:2,
      }],
    },
    options:{
      responsive:true, maintainAspectRatio:true,
      plugins:{ legend:{ position:'right', labels:{ color:MUTED, font:{size:12} } } },
    },
  });

  // Claim categories horizontal bar
  new Chart(document.getElementById('chart-claims'),{
    type:'bar',
    data:{
      labels: data.claimCategories.map(c=>c.type),
      datasets:[{ label:'Claims', data: data.claimCategories.map(c=>c.count),
        backgroundColor:ACCENT, borderRadius:4 }],
    },
    options:{
      ...baseChartOpts, indexAxis:'y',
      plugins:{ legend:{ display:false } },
    },
  });

  // Latency trend
  new Chart(document.getElementById('chart-latency'),{
    type:'line',
    data:{
      labels: labels30,
      datasets:[{
        label:'Avg Latency (ms)', data: data.latencyTrend.map(d=>d.avgMs),
        borderColor:WARN, backgroundColor:'rgba(245,166,35,.1)',
        fill:true, tension:.35, pointRadius:3, spanGaps:true,
      }],
    },
    options:{
      ...baseChartOpts,
      plugins:{ legend:{ display:false } },
      scales:{
        ...baseChartOpts.scales,
        y:{ ...baseChartOpts.scales.y, ticks:{ ...baseChartOpts.scales.y.ticks,
          callback:(v)=>v+'ms' } },
      },
    },
  });

  // Cache doughnut ring
  const hr = data.cacheStats.hitRate;
  new Chart(document.getElementById('chart-cache'),{
    type:'doughnut',
    data:{
      labels:['Hits','Misses'],
      datasets:[{
        data:[hr, Math.max(0,100-hr)],
        backgroundColor:[ACCENT2,'#22263a'],
        borderColor:'#0f1117', borderWidth:2,
        circumference:360, hoverOffset:4,
      }],
    },
    options:{
      responsive:true, maintainAspectRatio:true, cutout:'72%',
      plugins:{ legend:{ display:false }, tooltip:{ enabled:false } },
    },
  });
  document.getElementById('cache-pct').textContent = hr+'%';
  document.getElementById('c-size').textContent    = fmt(data.cacheStats.size);
  document.getElementById('c-hits').textContent    = fmt(data.cacheStats.hits);
  document.getElementById('c-misses').textContent  = fmt(data.cacheStats.misses);
  document.getElementById('c-rate').textContent    = hr+'%';

  document.getElementById('loading').classList.add('gone');
}

load().catch(err=>{
  document.getElementById('loading').classList.add('gone');
  console.error('Analytics load failed', err);
});
</script>
</body>
</html>`;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function analyticsRoutes(fastify: FastifyInstance): Promise<void> {

  /**
   * GET /analytics/overview — aggregate JSON for all chart panels
   */
  fastify.get(
    '/analytics/overview',
    {
      schema: {
        tags: ['Analytics'],
        summary: 'Aggregate analytics data for dashboard charts',
      },
    },
    async (_request, reply) => {
      return reply.send(computeOverview());
    },
  );

  /**
   * GET /analytics — HTML dashboard
   */
  fastify.get(
    '/analytics',
    {
      schema: {
        tags: ['Analytics'],
        summary: 'Usage analytics dashboard (HTML)',
      },
    },
    async (_request, reply) => {
      return reply.type('text/html').send(buildAnalyticsHtml());
    },
  );
}
