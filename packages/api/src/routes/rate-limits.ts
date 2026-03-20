import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getRateLimiter } from '../store/ratelimit.js';
import { getRateLimitAlertStore, ALERT_THRESHOLD_PCT } from '../store/rate-alerts.js';

// ── JSON payload type ──────────────────────────────────────────────────────────

function buildPayload() {
  const stats  = getRateLimiter().getAllStats();
  const alerts = getRateLimitAlertStore().getAlerts();
  const now    = new Date().toISOString();

  const throttledKeys = stats.filter(s => s.throttleCount > 0).length;
  const criticalKeys  = stats.filter(s => s.usedPct >= 100).length;
  const warningKeys   = stats.filter(s => s.usedPct >= ALERT_THRESHOLD_PCT && s.usedPct < 100).length;

  return { generatedAt: now, summary: { totalKeys: stats.length, throttledKeys, criticalKeys, warningKeys }, keys: stats, alerts: alerts.slice(0, 50) };
}

// ── HTML dashboard ─────────────────────────────────────────────────────────────

function statusBadge(pct: number): string {
  if (pct >= 100) return '<span class="badge badge-critical">THROTTLED</span>';
  if (pct >= ALERT_THRESHOLD_PCT) return '<span class="badge badge-warning">WARNING</span>';
  if (pct >= 50)  return '<span class="badge badge-moderate">ACTIVE</span>';
  return '<span class="badge badge-ok">OK</span>';
}

function meterBar(pct: number): string {
  const cls = pct >= 100 ? 'critical' : pct >= ALERT_THRESHOLD_PCT ? 'warning' : pct >= 50 ? 'moderate' : 'ok';
  const w   = Math.min(100, pct);
  return `<div class="meter-track"><div class="meter-fill meter-${cls}" style="width:${w}%"></div></div>`;
}

function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rate Limits — Faultline Pro</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
  header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:1.1rem;font-weight:600;color:#58a6ff}
  header .sub{font-size:0.8rem;color:#7d8590;margin-left:auto}
  .container{max-width:1100px;margin:0 auto;padding:24px}
  .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
  .stat-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
  .stat-card .label{font-size:0.75rem;color:#7d8590;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
  .stat-card .value{font-size:1.8rem;font-weight:700}
  .stat-card .value.critical{color:#f85149}
  .stat-card .value.warning{color:#d29922}
  .stat-card .value.neutral{color:#58a6ff}
  .stat-card .value.ok{color:#3fb950}
  h2{font-size:0.9rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
  .section{margin-bottom:32px}
  table{width:100%;border-collapse:collapse;font-size:0.85rem}
  th{text-align:left;padding:8px 12px;background:#161b22;color:#7d8590;border-bottom:1px solid #30363d;font-weight:500;font-size:0.75rem;text-transform:uppercase;letter-spacing:.04em}
  td{padding:8px 12px;border-bottom:1px solid #21262d;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .mono{font-family:'Fira Code','Courier New',monospace;font-size:0.8rem;color:#7d8590}
  .tier-admin{color:#d2a8ff}
  .tier-pro{color:#79c0ff}
  .tier-free{color:#7d8590}
  .badge{display:inline-block;font-size:0.7rem;font-weight:600;padding:2px 8px;border-radius:4px;letter-spacing:.03em}
  .badge-critical{background:#3d1a1a;color:#f85149;border:1px solid #f85149}
  .badge-warning{background:#2d2010;color:#d29922;border:1px solid #d29922}
  .badge-moderate{background:#1a2a3d;color:#58a6ff;border:1px solid #58a6ff}
  .badge-ok{background:#122023;color:#3fb950;border:1px solid #3fb950}
  .meter-track{background:#21262d;border-radius:4px;height:6px;width:100%;min-width:80px}
  .meter-fill{height:6px;border-radius:4px;transition:width .3s}
  .meter-ok{background:#3fb950}
  .meter-moderate{background:#58a6ff}
  .meter-warning{background:#d29922}
  .meter-critical{background:#f85149}
  .alert-row td:first-child{color:#d29922}
  .delivered{color:#3fb950;font-size:0.75rem}
  .undelivered{color:#7d8590;font-size:0.75rem}
  .empty{color:#7d8590;font-style:italic;padding:16px 12px;text-align:center}
  .refresh-bar{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 14px;font-size:0.78rem;color:#7d8590;display:flex;align-items:center;gap:8px;margin-bottom:20px}
  .dot{width:6px;height:6px;border-radius:50%;background:#3fb950;flex-shrink:0;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #countdown{font-weight:600;color:#58a6ff}
  .webhook-status{font-size:0.75rem;color:#7d8590;padding:8px 12px;background:#161b22;border:1px solid #30363d;border-radius:6px;margin-bottom:20px}
  .webhook-status span{font-weight:600;color:#58a6ff}
</style>
</head>
<body>
<header>
  <div style="font-size:1.2rem;font-weight:700;letter-spacing:-.02em"><span style="color:#f85149">fault</span>line pro</div>
  <h1>Rate Limit Dashboard</h1>
  <div class="sub" id="gen-at">—</div>
</header>
<div class="container">

  <div class="refresh-bar">
    <div class="dot"></div>
    Auto-refreshes in <span id="countdown">30</span>s
    &nbsp;·&nbsp; Alert threshold: ${ALERT_THRESHOLD_PCT}% of limit
    &nbsp;·&nbsp; Window: per-minute
  </div>

  <div id="webhook-note" class="webhook-status" style="display:none">
    Alert webhook: <span id="webhook-url">—</span>
  </div>

  <div class="summary">
    <div class="stat-card"><div class="label">Total Keys</div><div class="value neutral" id="s-total">—</div></div>
    <div class="stat-card"><div class="label">Throttled Keys</div><div class="value critical" id="s-throttled">—</div></div>
    <div class="stat-card"><div class="label">Warning ≥${ALERT_THRESHOLD_PCT}%</div><div class="value warning" id="s-warning">—</div></div>
    <div class="stat-card"><div class="label">Recent Alerts</div><div class="value ok" id="s-alerts">—</div></div>
  </div>

  <div class="section">
    <h2>Per-Key Usage</h2>
    <table>
      <thead><tr>
        <th>Key ID</th><th>Tier</th><th>Used / Limit</th><th>Usage</th><th>Throttled</th><th>Resets</th><th>Status</th>
      </tr></thead>
      <tbody id="keys-body"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
    </table>
  </div>

  <div class="section">
    <h2>Recent Alerts</h2>
    <table>
      <thead><tr>
        <th>Time</th><th>Key ID</th><th>Usage at Alert</th><th>Window</th><th>Delivery</th>
      </tr></thead>
      <tbody id="alerts-body"><tr><td colspan="5" class="empty">No alerts fired yet</td></tr></tbody>
    </table>
  </div>

</div>

<script>
const API_URL = '/rate-limits.json';

function tierClass(t) {
  return t === 'admin' ? 'tier-admin' : t === 'pro' ? 'tier-pro' : 'tier-free';
}
function badge(pct) {
  if (pct >= 100) return '<span class="badge badge-critical">THROTTLED</span>';
  if (pct >= ${ALERT_THRESHOLD_PCT}) return '<span class="badge badge-warning">WARNING</span>';
  if (pct >= 50) return '<span class="badge badge-moderate">ACTIVE</span>';
  return '<span class="badge badge-ok">OK</span>';
}
function meter(pct) {
  const cls = pct >= 100 ? 'critical' : pct >= ${ALERT_THRESHOLD_PCT} ? 'warning' : pct >= 50 ? 'moderate' : 'ok';
  return '<div class="meter-track"><div class="meter-fill meter-' + cls + '" style="width:' + Math.min(100, pct) + '%"></div></div>';
}
function ts(iso) {
  return new Date(iso).toLocaleTimeString();
}
function epochToTime(ep) {
  return new Date(ep * 1000).toLocaleTimeString();
}

async function load() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get('key') ?? '';
  const headers = key ? { 'x-api-key': key } : {};
  try {
    const res = await fetch(API_URL, { headers });
    if (!res.ok) {
      document.getElementById('keys-body').innerHTML = '<tr><td colspan="7" class="empty">Auth required — append ?key=YOUR_API_KEY to the URL</td></tr>';
      return;
    }
    const d = await res.json();
    document.getElementById('gen-at').textContent = 'as of ' + ts(d.generatedAt);
    document.getElementById('s-total').textContent     = d.summary.totalKeys;
    document.getElementById('s-throttled').textContent = d.summary.throttledKeys;
    document.getElementById('s-warning').textContent   = d.summary.warningKeys;
    document.getElementById('s-alerts').textContent    = d.alerts.length;

    // Keys table
    const kb = document.getElementById('keys-body');
    if (!d.keys.length) {
      kb.innerHTML = '<tr><td colspan="7" class="empty">No keys seen yet — make a scan request first</td></tr>';
    } else {
      kb.innerHTML = d.keys.map(k =>
        '<tr>' +
        '<td class="mono">' + k.keyId + '</td>' +
        '<td class="' + tierClass(k.tier) + '">' + k.tier + '</td>' +
        '<td>' + k.used + ' / ' + k.limit + '</td>' +
        '<td style="min-width:120px">' + meter(k.usedPct) + '<small style="color:#7d8590;font-size:.72rem">' + k.usedPct + '%</small></td>' +
        '<td>' + (k.throttleCount > 0 ? '<span style="color:#f85149;font-weight:600">' + k.throttleCount + '</span>' : '<span style="color:#7d8590">0</span>') + '</td>' +
        '<td class="mono" style="font-size:.75rem">' + epochToTime(k.resetEpoch) + '</td>' +
        '<td>' + badge(k.usedPct) + '</td>' +
        '</tr>'
      ).join('');
    }

    // Alerts table
    const ab = document.getElementById('alerts-body');
    if (!d.alerts.length) {
      ab.innerHTML = '<tr><td colspan="5" class="empty">No alerts fired yet</td></tr>';
    } else {
      ab.innerHTML = d.alerts.map(a =>
        '<tr class="alert-row">' +
        '<td class="mono" style="font-size:.75rem">' + ts(a.timestamp) + '</td>' +
        '<td class="mono">' + a.keyId + '</td>' +
        '<td>' + a.pct + '% (' + a.used + '/' + a.limit + ')</td>' +
        '<td class="mono" style="font-size:.75rem">' + a.windowKey + '</td>' +
        '<td class="' + (a.delivered ? 'delivered' : 'undelivered') + '">' + a.deliveryNote + '</td>' +
        '</tr>'
      ).join('');
    }
  } catch (e) {
    document.getElementById('keys-body').innerHTML = '<tr><td colspan="7" class="empty">Error loading data</td></tr>';
  }
}

let t = 30;
const cd = document.getElementById('countdown');
function tick() {
  t--;
  cd.textContent = t;
  if (t <= 0) { t = 30; load(); }
}
load();
setInterval(tick, 1000);
</script>
</body>
</html>`;
}

// ── Route registration ─────────────────────────────────────────────────────────

export async function rateLimitRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/rate-limits',
    {
      schema: {
        tags: ['Analytics'],
        summary: 'Rate limit dashboard (HTML)',
        description: 'Visual dashboard of per-key rate limit usage, throttled requests, and approaching-limit alerts. Append ?key=YOUR_API_KEY to the URL.',
        security: [],
      },
    },
    async (_request, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(buildHtml());
    },
  );

  fastify.get(
    '/rate-limits.json',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Analytics'],
        summary: 'Rate limit stats (JSON)',
        security: [{ apiKey: [] }],
      },
    },
    async (_request, reply) => {
      return reply.status(200).send(buildPayload());
    },
  );
}
