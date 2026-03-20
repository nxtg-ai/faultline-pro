import type { FastifyInstance } from 'fastify';
import { getKeyStore } from '../store/keys.js';
import { getAuditLogger } from '../store/audit.js';
import { getRateLimiter } from '../store/ratelimit.js';
import { getUsageMeter } from '../store/usage.js';
import { getAnalyticsStore } from '../store/analytics.js';
import {
  getUptimeMs,
  formatUptime,
  deriveIncidents,
  bucketResponseTimes,
} from '../store/status.js';

// ── /status.json shape ────────────────────────────────────────────────────────

export interface ProviderStatus {
  name: string;
  status: 'operational' | 'no_key';
}

export interface StatusPayload {
  generatedAt: string;
  uptimeMs: number;
  uptimeFormatted: string;
  overallStatus: 'operational' | 'degraded';
  providers: ProviderStatus[];
  responseTimes: { label: string; p50Ms: number; count: number }[];
  incidents: { timestamp: string; type: string; description: string }[];
  scanStats: { today: number; week: number; month: number };
}

function buildStatusPayload(): StatusPayload {
  const uptimeMs = getUptimeMs();
  const auditEntries = getAuditLogger().getEntries();
  const dashboard = getAnalyticsStore().getDashboard();

  const providers: ProviderStatus[] = [
    { name: 'Gemini',     status: process.env.GEMINI_API_KEY     ? 'operational' : 'no_key' },
    { name: 'OpenAI',     status: process.env.OPENAI_API_KEY     ? 'operational' : 'no_key' },
    { name: 'Claude',     status: process.env.ANTHROPIC_API_KEY  ? 'operational' : 'no_key' },
    { name: 'Perplexity', status: process.env.PERPLEXITY_API_KEY ? 'operational' : 'no_key' },
  ];

  const incidents = deriveIncidents(auditEntries);
  const responseTimes = bucketResponseTimes(auditEntries);
  const operationalCount = providers.filter(p => p.status === 'operational').length;
  const overallStatus = operationalCount === 0 && incidents.length > 0 ? 'degraded' : 'operational';

  return {
    generatedAt: new Date().toISOString(),
    uptimeMs,
    uptimeFormatted: formatUptime(uptimeMs),
    overallStatus,
    providers,
    responseTimes,
    incidents,
    scanStats: dashboard.scans,
  };
}

// ── Status HTML page ──────────────────────────────────────────────────────────

const STATUS_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Faultline Pro — Status</title>
<style>
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;--text:#e2e8f0;--muted:#718096;--green:#48bb78;--yellow:#ecc94b;--red:#fc8181;--blue:#63b3ed;--accent:#7c3aed}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:0 0 60px}
a{color:var(--blue);text-decoration:none}
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:24px 0}
.container{max-width:860px;margin:0 auto;padding:0 24px}
.header-inner{display:flex;align-items:center;gap:16px}
.logo{font-size:20px;font-weight:700;letter-spacing:-0.5px;color:var(--text)}
.logo span{color:var(--accent)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:600}
.badge-ok{background:#1a3a2a;color:var(--green)}
.badge-degraded{background:#3a2a1a;color:var(--yellow)}
.badge-outage{background:#3a1a1a;color:var(--red)}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.refresh{margin-left:auto;font-size:13px;color:var(--muted)}
.section{margin-top:32px}
.section-title{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px}
.stat-row{display:flex;gap:32px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:4px}
.stat-label{font-size:12px;color:var(--muted)}
.stat-value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.provider-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;display:flex;align-items:center;gap:12px}
.provider-icon{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.provider-icon.ok{background:#1a3a2a}
.provider-icon.warn{background:#2a2a1a}
.provider-name{font-size:14px;font-weight:500}
.provider-status{font-size:12px;margin-top:2px}
.ok-text{color:var(--green)}
.warn-text{color:var(--yellow)}
.chart-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px}
.chart-title{font-size:12px;color:var(--muted);margin-bottom:12px;display:flex;justify-content:space-between}
#chart{width:100%;height:80px;overflow:visible}
.chart-empty{color:var(--muted);font-size:13px;text-align:center;padding:20px 0}
.incidents{display:flex;flex-direction:column;gap:8px}
.incident{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--red);border-radius:8px;padding:12px 14px;display:flex;gap:12px;align-items:flex-start}
.incident.latency{border-left-color:var(--yellow)}
.incident-time{font-size:12px;color:var(--muted);white-space:nowrap;padding-top:1px}
.incident-desc{font-size:13px}
.all-ok{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;display:flex;align-items:center;gap:10px;color:var(--green);font-size:14px}
.skeleton{background:linear-gradient(90deg,var(--surface) 25%,var(--border) 50%,var(--surface) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:4px;height:1em}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
#error-banner{display:none;background:#3a1a1a;border:1px solid var(--red);border-radius:8px;padding:12px 16px;color:var(--red);font-size:13px;margin-top:24px}
</style>
</head>
<body>
<div class="header">
  <div class="container">
    <div class="header-inner">
      <span class="logo"><span>fault</span>line pro</span>
      <div id="overall-badge" class="badge badge-ok"><span class="dot"></span><span id="overall-text">Loading…</span></div>
      <span class="refresh" id="refresh-label">Refreshing in 30s</span>
    </div>
  </div>
</div>

<div class="container">
  <div id="error-banner"></div>

  <div class="section">
    <div class="section-title">System Overview</div>
    <div class="card">
      <div class="stat-row">
        <div class="stat"><span class="stat-label">Uptime</span><span class="stat-value" id="uptime">—</span></div>
        <div class="stat"><span class="stat-label">Scans Today</span><span class="stat-value" id="scans-today">—</span></div>
        <div class="stat"><span class="stat-label">Scans This Week</span><span class="stat-value" id="scans-week">—</span></div>
        <div class="stat"><span class="stat-label">Scans This Month</span><span class="stat-value" id="scans-month">—</span></div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Providers</div>
    <div class="provider-grid" id="providers">
      ${['Gemini','OpenAI','Claude','Perplexity'].map(n => `
      <div class="provider-card">
        <div class="provider-icon warn">⋯</div>
        <div><div class="provider-name">${n}</div><div class="provider-status warn-text">loading…</div></div>
      </div>`).join('')}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Response Time — last 60 min (p50 per minute)</div>
    <div class="chart-wrap">
      <div class="chart-title">
        <span>Latency (ms)</span>
        <span id="chart-peak">—</span>
      </div>
      <div id="chart-area"><div class="chart-empty">Collecting data…</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Recent Incidents</div>
    <div id="incidents"><div class="skeleton" style="height:48px"></div></div>
  </div>

  <p style="margin-top:24px;font-size:12px;color:var(--muted)">
    Data from <a href="/health/deep">/health/deep</a> &nbsp;·&nbsp;
    <a href="/docs">API Docs</a> &nbsp;·&nbsp;
    Last updated: <span id="last-updated">—</span>
  </p>
</div>

<script>
const ICONS = {Gemini:'✦',OpenAI:'⊕',Claude:'◈',Perplexity:'⌘'};
let countdown = 30;
let timer;

function fmt(iso){
  if(!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function sparkline(buckets){
  const vals = buckets.map(b => b.p50Ms);
  const peak = Math.max(...vals, 1);
  const W = 820, H = 70;
  const step = W / (vals.length - 1 || 1);
  const y = v => (H - (v / peak) * (H - 4)).toFixed(1);
  const points = vals.map((v,i) => \`\${(i*step).toFixed(1)},\${y(v)}\`).join(' ');
  const area   = vals.map((v,i) => (i===0 ? \`M\${(i*step).toFixed(1)},\${H}\` : '') + \`L\${(i*step).toFixed(1)},\${y(v)}\`).join(' ') + \` L\${W},\${H} Z\`;
  return \`<svg viewBox="0 0 \${W} \${H}" preserveAspectRatio="none" id="chart" style="width:100%;height:80px">
    <defs>
      <linearGradient id="grad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#7c3aed" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <path d="\${area}" fill="url(#grad)"/>
    <polyline points="\${points}" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>\`;
}

async function load(){
  try {
    const r = await fetch('/status.json');
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    render(d);
    document.getElementById('error-banner').style.display='none';
  } catch(e) {
    document.getElementById('error-banner').style.display='block';
    document.getElementById('error-banner').textContent = 'Failed to load status data: ' + e.message;
  }
}

function render(d){
  // Overall badge
  const badge = document.getElementById('overall-badge');
  const text  = document.getElementById('overall-text');
  badge.className = 'badge ' + (d.overallStatus==='operational' ? 'badge-ok' : 'badge-degraded');
  text.textContent = d.overallStatus==='operational' ? 'All Systems Operational' : 'Degraded';

  // Stats
  document.getElementById('uptime').textContent = d.uptimeFormatted ?? '—';
  document.getElementById('scans-today').textContent  = (d.scanStats?.today  ?? 0).toLocaleString();
  document.getElementById('scans-week').textContent   = (d.scanStats?.week   ?? 0).toLocaleString();
  document.getElementById('scans-month').textContent  = (d.scanStats?.month  ?? 0).toLocaleString();

  // Providers
  const pg = document.getElementById('providers');
  pg.innerHTML = d.providers.map(p => {
    const ok = p.status === 'operational';
    return \`<div class="provider-card">
      <div class="provider-icon \${ok ? 'ok' : 'warn'}" style="font-size:16px">\${ICONS[p.name]??'?'}</div>
      <div>
        <div class="provider-name">\${p.name}</div>
        <div class="provider-status \${ok ? 'ok-text' : 'warn-text'}">\${ok ? 'Operational' : 'No API key'}</div>
      </div>
    </div>\`;
  }).join('');

  // Chart
  const hasData = d.responseTimes && d.responseTimes.some(b => b.count > 0);
  const ca = document.getElementById('chart-area');
  if(hasData){
    const peak = Math.max(...d.responseTimes.map(b => b.p50Ms));
    document.getElementById('chart-peak').textContent = 'Peak p50: ' + peak.toFixed(1) + ' ms';
    ca.innerHTML = sparkline(d.responseTimes);
  } else {
    ca.innerHTML = '<div class="chart-empty">No requests recorded yet</div>';
    document.getElementById('chart-peak').textContent = '';
  }

  // Incidents
  const inc = document.getElementById('incidents');
  if(!d.incidents || d.incidents.length === 0){
    inc.innerHTML = '<div class="all-ok"><span>✓</span> No incidents in the last 60 minutes</div>';
  } else {
    inc.innerHTML = '<div class="incidents">' + d.incidents.map(i =>
      \`<div class="incident \${i.type==='latency' ? 'latency' : ''}">
        <span class="incident-time">\${fmt(i.timestamp)}</span>
        <span class="incident-desc">\${i.description}</span>
      </div>\`
    ).join('') + '</div>';
  }

  document.getElementById('last-updated').textContent = fmt(d.generatedAt);
}

function startCountdown(){
  clearInterval(timer);
  countdown = 30;
  timer = setInterval(() => {
    countdown--;
    const lbl = document.getElementById('refresh-label');
    if(countdown <= 0){
      lbl.textContent = 'Refreshing…';
      load().then(() => { countdown = 30; lbl.textContent = 'Refreshing in 30s'; });
    } else {
      lbl.textContent = 'Refreshing in ' + countdown + 's';
    }
  }, 1000);
}

load();
startCountdown();
</script>
</body>
</html>`;

// ── Routes ────────────────────────────────────────────────────────────────────

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', { schema: { tags: ['Monitoring'], summary: 'Basic health check — subsystem and provider status' } }, async (_request, _reply) => {
    const keyCount = getKeyStore().size;
    const providers = {
      gemini:     Boolean(process.env.GEMINI_API_KEY),
      openai:     Boolean(process.env.OPENAI_API_KEY),
      claude:     Boolean(process.env.ANTHROPIC_API_KEY),
      perplexity: Boolean(process.env.PERPLEXITY_API_KEY),
    };
    const anyProvider = Object.values(providers).some(Boolean);
    return {
      status: 'ok',
      service: 'faultline-api',
      version: '0.2.0',
      subsystems: {
        keyStore:   { status: 'ok', activeKeys: keyCount },
        scanEngine: { status: anyProvider ? 'ok' : 'degraded', providersConfigured: Object.values(providers).filter(Boolean).length },
      },
      providers,
    };
  });

  fastify.get('/health/deep', { schema: { tags: ['Monitoring'], summary: 'Deep health check — all subsystems with entry counts and analytics' } }, async (_request, _reply) => {
    const dashboard = getAnalyticsStore().getDashboard();
    const subsystems = {
      keyStore:   { status: 'ok' as const, activeKeys: getKeyStore().size },
      auditLog:   { status: 'ok' as const, entries: getAuditLogger().getEntries().length },
      rateLimiter:{ status: 'ok' as const },
      usageMeter: { status: 'ok' as const },
      analytics:  { status: 'ok' as const, totalScans: dashboard.scans.month },
    };
    const allOk = Object.values(subsystems).every((s) => s.status === 'ok');
    const providers = {
      gemini:     { status: 'ok' as const, configured: Boolean(process.env.GEMINI_API_KEY) },
      openai:     { status: 'ok' as const, configured: Boolean(process.env.OPENAI_API_KEY) },
      claude:     { status: 'ok' as const, configured: Boolean(process.env.ANTHROPIC_API_KEY) },
      perplexity: { status: 'ok' as const, configured: Boolean(process.env.PERPLEXITY_API_KEY) },
    };
    return {
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      subsystems,
      providers,
    };
  });

  // Machine-readable status JSON (polled by the status page)
  fastify.get('/status.json', { schema: { tags: ['Monitoring'], summary: 'Machine-readable status payload (JSON)' } }, async (_request, _reply) => {
    return buildStatusPayload();
  });

  // Human-readable status page (auto-refreshes via JS)
  fastify.get('/status', { schema: { tags: ['Monitoring'], summary: 'HTML status page — uptime, providers, response time chart, incidents' } }, async (_request, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return STATUS_HTML;
  });
}
