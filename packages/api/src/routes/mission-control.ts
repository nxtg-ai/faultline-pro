/**
 * Mission Control — System Health Dashboard (D-168)
 *
 * GET /mission-control/status  — aggregate JSON (all subsystems)
 * GET /mission-control         — HTML dashboard (auto-refresh 10s)
 */

import type { FastifyInstance } from 'fastify';
import { getProviderRegistry } from '../store/providers.js';
import { getScanCache } from '../store/cache.js';
import { getScanQueue } from '../store/scan-queue.js';
import { getKeyStore } from '../store/keys.js';
import { getScanHistory } from '../store/scan-history.js';
import { getAuditLogger } from '../store/audit.js';

// ── Data aggregation ──────────────────────────────────────────────────────────

function computeStatus() {
  const now = Date.now();
  const last60s = now - 60_000;
  const last5min = now - 5 * 60_000;
  const today = new Date().toISOString().slice(0, 10);

  // ── API latency (last 200 audit entries) ─────────────────────────────────
  const entries = getAuditLogger().getEntries();
  const recent = entries.slice(-200);
  const recentMs = recent.map(e => e.latencyMs).filter(ms => typeof ms === 'number');
  const sorted = [...recentMs].sort((a, b) => a - b);
  const avgLatency = recentMs.length > 0
    ? Math.round(recentMs.reduce((s, v) => s + v, 0) / recentMs.length)
    : 0;
  const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0;
  const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;

  // Requests in last 60s and 5min
  const rps60 = recent.filter(e => new Date(e.timestamp).getTime() >= last60s).length;
  const rps5min = recent.filter(e => new Date(e.timestamp).getTime() >= last5min).length;

  // ── Provider health ───────────────────────────────────────────────────────
  const providerSnapshot = getProviderRegistry().getHealthSnapshot();
  const providers = Object.entries(providerSnapshot).map(([name, h]) => ({
    name,
    status:     h.disabled ? 'disabled' : h.healthScore >= 0.8 ? 'healthy' : h.healthScore >= 0.5 ? 'degraded' : 'unhealthy',
    healthScore: Math.round((h.healthScore ?? 0) * 100),
    avgLatency:  h.avgLatencyMs ?? 0,
    errorRate:   Math.round((h.errorRate ?? 0) * 100),
    disabled:    h.disabled ?? false,
    totalRequests: h.totalRequests ?? 0,
  }));
  const healthyProviders = providers.filter(p => p.status === 'healthy').length;
  const totalProviders = providers.length;

  // ── Cache stats ───────────────────────────────────────────────────────────
  const cache = getScanCache().stats();

  // ── Queue stats ───────────────────────────────────────────────────────────
  const queue = getScanQueue().getStats();

  // ── Active keys ───────────────────────────────────────────────────────────
  const keys = getKeyStore().list();
  const activeKeys = keys.length;
  const totalKeys = keys.length;

  // ── Scan rate / today's volume ────────────────────────────────────────────
  const history = getScanHistory().getRecent(1000);
  const scansToday = history.filter(e => e.timestamp.slice(0, 10) === today).length;
  const scansLast60s = history.filter(e => new Date(e.timestamp).getTime() >= last60s).length;
  const scansLast5min = history.filter(e => new Date(e.timestamp).getTime() >= last5min).length;

  // Recent risk distribution (last 50 scans)
  const last50 = history.slice(0, 50);
  const riskCounts: Record<string, number> = { Low: 0, Medium: 0, High: 0, Critical: 0 };
  for (const e of last50) {
    const r = e.overallRisk
      ? e.overallRisk.charAt(0).toUpperCase() + e.overallRisk.slice(1).toLowerCase()
      : 'Low';
    riskCounts[r] = (riskCounts[r] ?? 0) + 1;
  }

  // ── Overall system status ─────────────────────────────────────────────────
  const systemOk = (
    (totalProviders === 0 || healthyProviders > 0) &&
    queue.pending < 500 &&
    (cache.size < 10_000 || cache.hitRate > 0.1)
  );
  const systemStatus = !systemOk
    ? 'degraded'
    : providers.some(p => p.status === 'unhealthy')
    ? 'warning'
    : 'healthy';

  return {
    timestamp:  new Date().toISOString(),
    system:     systemStatus,
    latency: {
      avg: avgLatency,
      p50,
      p95,
      requestsLast60s:  rps60,
      requestsLast5min: rps5min,
    },
    providers,
    providerSummary: { healthy: healthyProviders, total: totalProviders },
    cache: {
      size:    cache.size,
      hits:    cache.hits,
      misses:  cache.misses,
      hitRate: Math.round(cache.hitRate * 100),
    },
    queue: {
      pending:    queue.pending,
      processing: queue.processing,
      completed:  queue.completed,
      failed:     queue.failed,
    },
    keys: { active: activeKeys, total: totalKeys },
    scans: {
      today:       scansToday,
      last60s:     scansLast60s,
      last5min:    scansLast5min,
      riskCounts,
    },
  };
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildMissionControlHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Faultline Pro — Mission Control</title>
<style>
  :root{--bg:#0b0d14;--surface:#131620;--surface2:#1c2035;--border:#252a42;--accent:#6c63ff;--green:#00c9a7;--yellow:#f5a623;--red:#e05c5c;--text:#e2e4f0;--muted:#6a6f8a;--r:8px}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:13px;min-height:100vh}
  header{padding:14px 24px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;justify-content:space-between}
  .logo{display:flex;align-items:center;gap:10px}
  .logo-icon{width:28px;height:28px;background:var(--accent);border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:#fff}
  .logo h1{font-size:15px;font-weight:700}
  .logo span{font-size:11px;color:var(--muted);margin-left:4px}
  .header-right{display:flex;align-items:center;gap:16px;font-size:12px;color:var(--muted)}
  .sys-pill{padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
  .sys-pill.healthy{background:rgba(0,201,167,.15);color:var(--green)}
  .sys-pill.warning{background:rgba(245,166,35,.15);color:var(--yellow)}
  .sys-pill.degraded{background:rgba(224,92,92,.15);color:var(--red)}
  main{padding:20px 24px;max-width:1400px;margin:0 auto}
  .section-title{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin:20px 0 10px}
  .kpi-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px}
  .kpi .label{font-size:11px;color:var(--muted);margin-bottom:6px;font-weight:500}
  .kpi .value{font-size:22px;font-weight:700;line-height:1}
  .kpi .sub{font-size:11px;color:var(--muted);margin-top:4px}
  .kpi.ok .value{color:var(--green)}
  .kpi.warn .value{color:var(--yellow)}
  .kpi.bad .value{color:var(--red)}
  .kpi.neutral .value{color:var(--text)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px}
  .panel h3{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px}
  .provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
  .prov{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:12px}
  .prov-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .prov-name{font-size:12px;font-weight:600;text-transform:capitalize}
  .status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .status-dot.healthy{background:var(--green)}
  .status-dot.degraded{background:var(--yellow)}
  .status-dot.unhealthy,.status-dot.disabled{background:var(--red)}
  .prov-score{font-size:20px;font-weight:700;margin-bottom:2px}
  .prov-score.healthy{color:var(--green)}
  .prov-score.degraded{color:var(--yellow)}
  .prov-score.unhealthy,.prov-score.disabled{color:var(--red)}
  .prov-detail{font-size:11px;color:var(--muted)}
  .stat-row{display:flex;flex-direction:column;gap:8px}
  .stat-item{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)}
  .stat-item:last-child{border-bottom:none}
  .stat-item .sk{color:var(--muted);font-size:12px}
  .stat-item .sv{font-size:12px;font-weight:600}
  .bar-wrap{background:var(--surface2);border-radius:4px;height:6px;overflow:hidden;margin-top:4px}
  .bar-fill{height:6px;border-radius:4px;transition:width .5s}
  .bar-fill.green{background:var(--green)}
  .bar-fill.yellow{background:var(--yellow)}
  .bar-fill.red{background:var(--red)}
  .bar-fill.blue{background:var(--accent)}
  .risk-row{display:flex;gap:6px;margin-top:4px}
  .risk-chip{flex:1;text-align:center;padding:4px 2px;border-radius:4px;font-size:11px;font-weight:600}
  .risk-chip.Low{background:rgba(0,201,167,.15);color:var(--green)}
  .risk-chip.Medium{background:rgba(245,166,35,.15);color:var(--yellow)}
  .risk-chip.High{background:rgba(224,92,92,.2);color:var(--red)}
  .risk-chip.Critical{background:rgba(224,92,92,.35);color:#ff7070}
  .refresh-bar{height:3px;background:var(--border);position:fixed;top:0;left:0;width:100%}
  .refresh-progress{height:3px;background:var(--accent);transition:width 10s linear}
  .ts{font-size:11px;color:var(--muted)}
  @media(max-width:900px){.kpi-grid{grid-template-columns:repeat(3,1fr)}.provider-grid{grid-template-columns:repeat(2,1fr)}.grid2,.grid3{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="refresh-bar"><div class="refresh-progress" id="rp" style="width:0%"></div></div>
<header>
  <div class="logo">
    <div class="logo-icon">F</div>
    <h1>Mission Control<span>Faultline Pro</span></h1>
  </div>
  <div class="header-right">
    <span>Auto-refresh: 10s</span>
    <span class="sys-pill" id="sys-pill">…</span>
  </div>
</header>
<main>
  <div class="section-title">System Overview</div>
  <div class="kpi-grid" id="kpi-grid">
    <div class="kpi neutral"><div class="label">Scans Today</div><div class="value" id="kpi-today">—</div><div class="sub" id="kpi-rate">— /min</div></div>
    <div class="kpi neutral"><div class="label">Active Keys</div><div class="value" id="kpi-keys">—</div><div class="sub" id="kpi-total-keys">— total</div></div>
    <div class="kpi neutral"><div class="label">Queue Depth</div><div class="value" id="kpi-queue">—</div><div class="sub" id="kpi-proc">— processing</div></div>
    <div class="kpi neutral"><div class="label">Cache Hit Rate</div><div class="value" id="kpi-hitrate">—</div><div class="sub" id="kpi-cache-size">— cached</div></div>
    <div class="kpi neutral"><div class="label">Avg Latency</div><div class="value" id="kpi-latency">—</div><div class="sub" id="kpi-p95">p95: —</div></div>
    <div class="kpi neutral"><div class="label">Providers OK</div><div class="value" id="kpi-providers">—</div><div class="sub" id="kpi-prov-total">— total</div></div>
  </div>

  <div class="section-title">Provider Health</div>
  <div class="provider-grid" id="prov-grid"></div>

  <div class="section-title">Subsystem Detail</div>
  <div class="grid3">
    <div class="panel">
      <h3>Cache</h3>
      <div class="stat-row" id="cache-stats"></div>
    </div>
    <div class="panel">
      <h3>Queue</h3>
      <div class="stat-row" id="queue-stats"></div>
    </div>
    <div class="panel">
      <h3>Recent Risk Distribution <span style="font-weight:400;color:var(--muted)">(last 50 scans)</span></h3>
      <div id="risk-dist" style="margin-top:8px"></div>
    </div>
  </div>

  <div class="section-title">API Latency</div>
  <div class="grid2">
    <div class="panel">
      <h3>Response Time</h3>
      <div class="stat-row" id="latency-stats"></div>
    </div>
    <div class="panel">
      <h3>Throughput</h3>
      <div class="stat-row" id="throughput-stats"></div>
    </div>
  </div>

  <div style="margin-top:16px;text-align:right" class="ts" id="last-updated">Last updated: —</div>
</main>
<script>
function setKpi(id, value, sub, cls) {
  const el = document.getElementById(id);
  if (el) { el.textContent = value; const p = el.closest('.kpi'); if(p && cls) { p.className='kpi '+cls; } }
  const se = document.getElementById(sub);
  if (se && sub) se.textContent = sub;
}
function statRow(items) {
  return items.map(([k, v, barPct, barColor]) =>
    \`<div class="stat-item"><span class="sk">\${k}</span><span class="sv">\${v}</span></div>\` +
    (barPct !== undefined ? \`<div class="bar-wrap"><div class="bar-fill \${barColor}" style="width:\${barPct}%"></div></div>\` : '')
  ).join('');
}
function render(d) {
  // System pill
  const pill = document.getElementById('sys-pill');
  if (pill) { pill.className = 'sys-pill ' + d.system; pill.textContent = d.system.toUpperCase(); }

  // KPIs
  document.getElementById('kpi-today').textContent = d.scans.today;
  document.getElementById('kpi-rate').textContent = (d.scans.last5min / 5).toFixed(1) + '/min avg';
  const keyEl = document.getElementById('kpi-keys');
  if (keyEl) keyEl.textContent = d.keys.active;
  document.getElementById('kpi-total-keys').textContent = d.keys.total + ' total';
  const qEl = document.getElementById('kpi-queue');
  if (qEl) { qEl.textContent = d.queue.pending; qEl.closest('.kpi').className = 'kpi ' + (d.queue.pending > 100 ? 'warn' : d.queue.pending > 500 ? 'bad' : 'ok'); }
  document.getElementById('kpi-proc').textContent = d.queue.processing + ' processing';
  const hrEl = document.getElementById('kpi-hitrate');
  if (hrEl) { hrEl.textContent = d.cache.hitRate + '%'; hrEl.closest('.kpi').className = 'kpi ' + (d.cache.hitRate >= 60 ? 'ok' : d.cache.hitRate >= 30 ? 'warn' : 'neutral'); }
  document.getElementById('kpi-cache-size').textContent = d.cache.size + ' cached';
  const latEl = document.getElementById('kpi-latency');
  if (latEl) { latEl.textContent = d.latency.avg + 'ms'; latEl.closest('.kpi').className = 'kpi ' + (d.latency.avg < 200 ? 'ok' : d.latency.avg < 1000 ? 'warn' : 'bad'); }
  document.getElementById('kpi-p95').textContent = 'p95: ' + d.latency.p95 + 'ms';
  const pvEl = document.getElementById('kpi-providers');
  if (pvEl) { pvEl.textContent = d.providerSummary.healthy + '/' + d.providerSummary.total; pvEl.closest('.kpi').className = 'kpi ' + (d.providerSummary.healthy === d.providerSummary.total && d.providerSummary.total > 0 ? 'ok' : d.providerSummary.healthy > 0 ? 'warn' : 'bad'); }
  document.getElementById('kpi-prov-total').textContent = d.providerSummary.total + ' total';

  // Provider grid
  const pg = document.getElementById('prov-grid');
  if (pg) {
    if (d.providers.length === 0) {
      pg.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px">No providers registered</div>';
    } else {
      pg.innerHTML = d.providers.map(p => \`
        <div class="prov">
          <div class="prov-header">
            <span class="prov-name">\${p.name}</span>
            <span class="status-dot \${p.status}"></span>
          </div>
          <div class="prov-score \${p.status}">\${p.healthScore}<span style="font-size:13px;font-weight:400">%</span></div>
          <div class="prov-detail">Latency: \${p.avgLatency}ms</div>
          <div class="prov-detail">Errors: \${p.errorRate}%</div>
          <div class="prov-detail">Requests: \${p.totalRequests}</div>
          \${p.disabled ? '<div class="prov-detail" style="color:var(--red);margin-top:4px">DISABLED</div>' : ''}
        </div>
      \`).join('');
    }
  }

  // Cache
  const cs = document.getElementById('cache-stats');
  if (cs) cs.innerHTML = statRow([
    ['Entries Cached', d.cache.size],
    ['Cache Hits', d.cache.hits],
    ['Cache Misses', d.cache.misses],
    ['Hit Rate', d.cache.hitRate + '%', d.cache.hitRate, d.cache.hitRate >= 60 ? 'green' : d.cache.hitRate >= 30 ? 'yellow' : 'blue'],
  ]);

  // Queue
  const qs = document.getElementById('queue-stats');
  if (qs) qs.innerHTML = statRow([
    ['Pending', d.queue.pending],
    ['Processing', d.queue.processing],
    ['Completed', d.queue.completed],
    ['Failed', d.queue.failed],
  ]);

  // Risk distribution
  const rd = document.getElementById('risk-dist');
  if (rd) {
    const total = Object.values(d.scans.riskCounts).reduce((s, v) => s + v, 0);
    rd.innerHTML = '<div class="risk-row">' +
      ['Low', 'Medium', 'High', 'Critical'].map(r =>
        \`<div class="risk-chip \${r}">\${r}<br><strong>\${d.scans.riskCounts[r] ?? 0}</strong></div>\`
      ).join('') + '</div>' +
      \`<div style="margin-top:8px;font-size:11px;color:var(--muted)">\${total} scans sampled</div>\`;
  }

  // Latency
  const ls = document.getElementById('latency-stats');
  if (ls) ls.innerHTML = statRow([
    ['Average', d.latency.avg + 'ms', Math.min(100, d.latency.avg / 10), d.latency.avg < 200 ? 'green' : d.latency.avg < 1000 ? 'yellow' : 'red'],
    ['p50', d.latency.p50 + 'ms'],
    ['p95', d.latency.p95 + 'ms'],
  ]);

  const ts = document.getElementById('throughput-stats');
  if (ts) ts.innerHTML = statRow([
    ['Requests (last 60s)', d.latency.requestsLast60s],
    ['Requests (last 5min)', d.latency.requestsLast5min],
    ['Scans (last 60s)', d.scans.last60s],
    ['Scans (last 5min)', d.scans.last5min],
  ]);

  // Timestamp
  const up = document.getElementById('last-updated');
  if (up) up.textContent = 'Last updated: ' + new Date(d.timestamp).toLocaleTimeString();
}

async function refresh() {
  try {
    const res = await fetch('/mission-control/status');
    if (res.ok) render(await res.json());
  } catch {}
}

// Progress bar animation
function startProgress() {
  const rp = document.getElementById('rp');
  if (!rp) return;
  rp.style.transition = 'none';
  rp.style.width = '0%';
  // Force reflow
  rp.offsetWidth;
  rp.style.transition = 'width 10s linear';
  rp.style.width = '100%';
}

refresh();
startProgress();
setInterval(() => { refresh(); startProgress(); }, 10_000);
</script>
</body>
</html>`;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function missionControlRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/mission-control/status',
    {
      schema: {
        tags: ['Monitoring'],
        summary: 'Mission Control status — all subsystem health in one JSON payload',
      },
    },
    async (_request, reply) => {
      return reply.send(computeStatus());
    },
  );

  fastify.get(
    '/mission-control',
    {
      schema: {
        tags: ['Monitoring'],
        summary: 'Mission Control HTML dashboard — auto-refresh 10s',
      },
    },
    async (_request, reply) => {
      return reply.type('text/html').send(buildMissionControlHtml());
    },
  );
}
