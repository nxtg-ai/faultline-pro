import type { FastifyInstance } from 'fastify';
import { getScanHistory, hashText } from '../store/scan-history.js';
import { requireApiKey, requireAdmin } from '../plugins/auth.js';

export async function scansRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /scans/timeline — timeline view for a document scanned multiple times
  fastify.get<{ Querystring: { text_hash?: string; text?: string; limit?: string } }>(
    '/scans/timeline',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Claims'],
        summary: 'Trust score timeline for a document scanned multiple times',
        description: 'Pass text_hash (sha256 of input text) or text (raw input, hash computed server-side). Returns scans in chronological order with per-scan deltas.',
        querystring: {
          type: 'object',
          properties: {
            text_hash: { type: 'string' },
            text:      { type: 'string' },
            limit:     { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { text_hash, text, limit } = request.query;
      const hash = text_hash ?? (text ? hashText(text) : null);
      if (!hash) {
        return reply.status(400).send({ error: 'Provide text_hash or text.' });
      }
      const limitNum = limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50;
      const timeline = getScanHistory().getTimeline(hash, limitNum);
      return reply.send({
        textHash:  hash,
        scanCount: timeline.length,
        timeline,
      });
    },
  );

  // GET /scans/timeline/view — HTML timeline dashboard
  fastify.get<{ Querystring: { text_hash?: string } }>(
    '/scans/timeline/view',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Claims'],
        summary: 'HTML timeline dashboard for a document (pass ?text_hash=)',
        security: [],
      },
    },
    async (_request, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(buildTimelineHtml());
    },
  );

  // GET /scans/usage — per-textHash scan analytics
  fastify.get<{ Querystring: { staleDays?: string; tenantId?: string } }>(
    '/scans/usage',
    {
      preHandler: requireApiKey,
      schema: {
        tags: ['Claims'],
        summary: 'Per-document scan analytics — frequency, risk drift, provider distribution, staleness flag.',
        querystring: {
          type: 'object',
          properties: {
            staleDays: { type: 'string', pattern: '^[0-9]+$' },
            tenantId:  { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const staleDays = Math.min(365, Math.max(1, parseInt(request.query.staleDays ?? '30', 10)));
      const stats     = getScanHistory().getScanUsageStats(staleDays, request.query.tenantId);

      const summary = {
        total:            stats.length,
        staleCount:       stats.filter((s) => s.isStale).length,
        riskDriftedCount: stats.filter((s) => s.riskDrifted).length,
      };

      return reply.status(200).send({ staleDays, ...summary, stats });
    },
  );

  // GET /scans/stale/view — scan hygiene HTML dashboard
  fastify.get<{ Querystring: { staleDays?: string } }>(
    '/scans/stale/view',
    {
      preHandler: requireApiKey,
      schema: { tags: ['Claims'], summary: 'Scan hygiene dashboard (HTML)' },
    },
    async (request, reply) => {
      const staleDays = Math.min(365, Math.max(1, parseInt(request.query.staleDays ?? '30', 10)));
      const stats     = getScanHistory().getScanUsageStats(staleDays);

      const staleCount       = stats.filter((s) => s.isStale).length;
      const riskDriftedCount = stats.filter((s) => s.riskDrifted).length;
      const total            = stats.length;

      const badge = (label: string, count: number, colour: string) =>
        `<div style="background:${colour};border-radius:8px;padding:16px 24px;min-width:100px;text-align:center;">
          <div style="font-size:2em;font-weight:700;">${count}</div>
          <div style="font-size:.85em;opacity:.85;">${label}</div>
        </div>`;

      const riskColour = (risk: string) => {
        const map: Record<string, string> = { Critical: '#dc2626', High: '#ea580c', Medium: '#ca8a04', Low: '#16a34a' };
        return map[risk] ?? '#6b7280';
      };

      const rows = stats.length === 0
        ? '<tr><td colspan="7" style="text-align:center;padding:32px;color:#9ca3af;">No scan history found.</td></tr>'
        : stats.map((s) => {
            const staleChip = s.isStale
              ? '<span style="background:#ca8a04;color:#fff;border-radius:4px;padding:2px 6px;font-size:.75em;margin-left:4px;">STALE</span>'
              : '';
            const driftChip = s.riskDrifted
              ? '<span style="background:#7c3aed;color:#fff;border-radius:4px;padding:2px 6px;font-size:.75em;margin-left:4px;">DRIFT</span>'
              : '';
            const riskBadge = `<span style="color:${riskColour(s.latestRisk)};font-weight:600;">${s.latestRisk}</span>`;
            return `<tr style="border-bottom:1px solid #1f2937;">
              <td style="padding:10px 12px;font-family:monospace;font-size:.8em;color:#64748b;">${s.textHash.slice(0, 8)}</td>
              <td style="padding:10px 12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${s.textPreview}">${s.textPreview.slice(0, 60)}…</td>
              <td style="padding:10px 12px;">${riskBadge}${staleChip}${driftChip}</td>
              <td style="padding:10px 12px;text-align:center;">${s.scanCount}</td>
              <td style="padding:10px 12px;color:#9ca3af;font-size:.85em;">${s.daysSinceLastScan}d ago</td>
              <td style="padding:10px 12px;color:#9ca3af;font-size:.85em;">${s.providers.join(', ')}</td>
              <td style="padding:10px 12px;color:#9ca3af;font-size:.85em;">${s.avgLatencyMs}ms</td>
            </tr>`;
          }).join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>Scan Hygiene — Faultline</title>
  <style>
    body{margin:0;background:#0f172a;color:#f1f5f9;font-family:system-ui,sans-serif;}
    h1{margin:0;font-size:1.4em;font-weight:700;}
    table{width:100%;border-collapse:collapse;}
    th{text-align:left;padding:8px 12px;font-size:.75em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #1f2937;}
    tr:hover td{background:#1e293b;}
  </style>
</head>
<body>
  <div style="padding:24px 32px;border-bottom:1px solid #1f2937;display:flex;align-items:center;justify-content:space-between;">
    <h1>🔍 Scan Hygiene Dashboard</h1>
    <span style="color:#64748b;font-size:.85em;">stale≥${staleDays}d · auto-refresh 60s</span>
  </div>
  <div style="padding:24px 32px;">
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:32px;">
      ${badge('Total Documents', total, '#1e293b')}
      ${badge('Stale', staleCount, '#78350f')}
      ${badge('Risk Drifted', riskDriftedCount, '#4c1d95')}
    </div>
    <table>
      <thead>
        <tr>
          <th>Hash</th><th>Preview</th><th>Risk / Flags</th>
          <th>Scans</th><th>Last Verified</th><th>Providers</th><th>Avg Latency</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`;

      return reply.status(200).header('content-type', 'text/html; charset=utf-8').send(html);
    },
  );

  // DELETE /scans/stale — prune all entries for stale textHash groups
  fastify.delete<{ Querystring: { days?: string } }>(
    '/scans/stale',
    {
      preHandler: requireAdmin,
      schema: {
        tags: ['Claims'],
        summary: 'Bulk-prune scan history: delete all entries for documents not re-verified in ≥N days (default 30). Admin-only.',
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request, reply) => {
      const days   = Math.min(365, Math.max(1, parseInt(request.query.days ?? '30', 10)));
      const result = getScanHistory().pruneStaleGroups(days);
      return reply.status(200).send({ days, ...result });
    },
  );

  // GET /scans/stale — documents not re-verified for ≥N days
  fastify.get<{ Querystring: { days?: string; tenantId?: string } }>(
    '/scans/stale',
    {
      preHandler: requireApiKey,
      schema: {
        tags: ['Claims'],
        summary: 'List documents not re-verified for ≥N days (default 30). Returns the most recent scan per unique text, filtered to those older than the threshold.',
        querystring: {
          type: 'object',
          properties: {
            days:     { type: 'string', pattern: '^[0-9]+$' },
            tenantId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const days  = Math.min(365, Math.max(1, parseInt(request.query.days ?? '30', 10)));
      const scans = getScanHistory().getStaleScanGroups(days, request.query.tenantId);
      return reply.status(200).send({ days, count: scans.length, scans });
    },
  );

  fastify.get<{
    Querystring: {
      q?: string;
      from?: string;
      to?: string;
      provider?: string;
      risk?: string;
      cursor?: string;
      limit?: string;
      tenantId?: string;
    };
  }>(
    '/scans/search',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Claims'],
        summary: 'Full-text search across scan history with cursor pagination',
        querystring: {
          type: 'object',
          properties: {
            q:        { type: 'string' },
            from:     { type: 'string' },
            to:       { type: 'string' },
            provider: { type: 'string' },
            risk:     { type: 'string' },
            cursor:   { type: 'string' },
            limit:    { type: 'string' },
            tenantId: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { q, from, to, provider, risk, cursor, limit, tenantId } = request.query;
      const limitNum = limit ? Math.min(parseInt(limit, 10) || 20, 100) : 20;
      const result = getScanHistory().search({ q, from, to, provider, risk, cursor, limit: limitNum, tenantId });
      return reply.status(200).send({
        scans: result.entries,
        nextCursor: result.nextCursor,
        total: result.entries.length,
      });
    },
  );
}

// ── HTML timeline dashboard ───────────────────────────────────────────────────

function buildTimelineHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scan Timeline — Faultline Pro</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
  header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:1.1rem;font-weight:600;color:#58a6ff}
  .container{max-width:960px;margin:0 auto;padding:24px}
  .search-bar{display:flex;gap:10px;margin-bottom:24px}
  .search-bar input{flex:1;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 12px;color:#e6edf3;font-size:.9rem}
  .search-bar input:focus{outline:none;border-color:#58a6ff}
  .search-bar button{background:#238636;border:none;border-radius:6px;padding:8px 16px;color:#fff;cursor:pointer;font-size:.9rem}
  .search-bar button:hover{background:#2ea043}
  .meta{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 18px;margin-bottom:20px;font-size:.83rem;color:#7d8590;display:flex;gap:20px}
  .meta span{color:#e6edf3;font-weight:600}
  .timeline{position:relative}
  .timeline::before{content:'';position:absolute;left:18px;top:0;bottom:0;width:2px;background:#30363d}
  .tentry{position:relative;padding-left:48px;margin-bottom:20px}
  .dot{position:absolute;left:10px;top:14px;width:18px;height:18px;border-radius:50%;border:2px solid #30363d;background:#0d1117;display:flex;align-items:center;justify-content:center;font-size:.62rem;font-weight:700}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 18px}
  .card-header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .scan-num{font-size:.72rem;color:#7d8590}
  .timestamp{font-size:.72rem;color:#7d8590;margin-left:auto}
  .provider{font-size:.72rem;background:#21262d;border:1px solid #30363d;border-radius:3px;padding:1px 7px}
  .badge{display:inline-block;padding:1px 7px;border-radius:3px;font-size:.72rem;font-weight:600;border:1px solid}
  .risk-Low{background:#122023;color:#3fb950;border-color:#3fb950}
  .risk-Medium{background:#2d2010;color:#d29922;border-color:#d29922}
  .risk-High{background:#3d1a1a;color:#f85149;border-color:#f85149}
  .risk-Critical{background:#4a0d0d;color:#ff6b6b;border-color:#ff6b6b}
  .risk-Unknown{background:#21262d;color:#7d8590;border-color:#7d8590}
  .delta-row{font-size:.78rem;color:#7d8590;display:flex;gap:16px;margin-top:6px}
  .delta-pos{color:#3fb950}.delta-neg{color:#f85149}.delta-zero{color:#7d8590}
  .risk-change{background:#2d1f05;border:1px solid #d29922;border-radius:4px;padding:3px 8px;font-size:.72rem;color:#d29922;margin-top:6px;display:inline-block}
  #error{color:#f85149;margin-bottom:16px;font-size:.85rem}
  .empty{color:#7d8590;font-style:italic;padding:24px 0}
</style>
</head>
<body>
<header>
  <div style="font-size:1.2rem;font-weight:700;letter-spacing:-.02em"><span style="color:#f85149">fault</span>line pro</div>
  <h1>Scan Timeline</h1>
</header>
<div class="container">

  <div class="search-bar">
    <input id="hash-input" type="text" placeholder="Paste sha256 text_hash (64 hex chars)…" />
    <button onclick="load()">View Timeline</button>
  </div>

  <div id="error" style="display:none"></div>
  <div id="meta" style="display:none" class="meta">
    Document scanned <span id="scan-count">—</span> times &nbsp;·&nbsp; Hash: <span id="hash-display" style="font-family:monospace;font-size:.75rem">—</span>
  </div>

  <div id="timeline" class="timeline"></div>
</div>

<script>
const RISK_ORDER = { Low: 1, Medium: 2, High: 3, Critical: 4 };
function riskClass(r) { return 'risk-' + (r || 'Unknown'); }
function delta(n) {
  if (n > 0) return '<span class="delta-pos">+' + n + ' new claims</span>';
  if (n < 0) return '<span class="delta-neg">' + n + ' claims resolved</span>';
  return '<span class="delta-zero">no claim count change</span>';
}
async function load() {
  const hash = document.getElementById('hash-input').value.trim();
  const err = document.getElementById('error');
  err.style.display = 'none';
  if (!hash) { err.textContent = 'Enter a text_hash.'; err.style.display = ''; return; }
  try {
    const d = await fetch('/scans/timeline?text_hash=' + encodeURIComponent(hash)).then(r => r.json());
    if (d.error) { err.textContent = d.error; err.style.display = ''; return; }
    document.getElementById('scan-count').textContent = d.scanCount;
    document.getElementById('hash-display').textContent = hash.slice(0,16) + '…';
    document.getElementById('meta').style.display = '';

    const tl = document.getElementById('timeline');
    if (d.scanCount === 0) { tl.innerHTML = '<div class="empty">No scans found for this document.</div>'; return; }
    tl.innerHTML = d.timeline.map(e => {
      const riskBadge = '<span class="badge ' + riskClass(e.overallRisk) + '">' + (e.overallRisk || 'Unknown') + '</span>';
      const dotColor = e.overallRisk === 'Low' ? '#3fb950' : e.overallRisk === 'Medium' ? '#d29922' : e.overallRisk === 'High' ? '#f85149' : '#58a6ff';
      const riskChangeHtml = e.riskChanged ? '<div class="risk-change">⚡ Risk changed: ' + e.previousRisk + ' → ' + e.overallRisk + '</div>' : '';
      return \`<div class="tentry">
        <div class="dot" style="border-color:\${dotColor};color:\${dotColor}">\${e.scanNumber}</div>
        <div class="card">
          <div class="card-header">
            <span class="scan-num">Scan #\${e.scanNumber}</span>
            \${riskBadge}
            <span class="provider">\${e.provider}</span>
            <span class="timestamp">\${new Date(e.timestamp).toLocaleString()}</span>
          </div>
          <div class="delta-row">
            <span>Claims: \${e.claimCount}</span>
            \${e.scanNumber > 1 ? delta(e.claimDelta) : ''}
            <span>Latency: \${e.latencyMs}ms</span>
          </div>
          \${riskChangeHtml}
        </div>
      </div>\`;
    }).join('');
  } catch(e) { err.textContent = 'Error: ' + e.message; err.style.display = ''; }
}
// Auto-load if text_hash is in query string
const params = new URLSearchParams(location.search);
if (params.get('text_hash')) {
  document.getElementById('hash-input').value = params.get('text_hash');
  load();
}
</script>
</body>
</html>`;
}
