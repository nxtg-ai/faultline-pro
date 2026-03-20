/**
 * Provider routes (D-124 + D-125)
 *
 * POST /providers/register — register a custom external provider plugin
 * GET  /providers/health   — health dashboard for all tracked providers
 */

import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { requireAdmin } from '../plugins/auth.js';
import { getProviderRegistry } from '../store/providers.js';
import { getCircuitBreaker, PROVIDER_CHAIN } from '../store/circuit-breaker.js';

const REGISTER_SCHEMA = {
  type: 'object',
  required: ['name', 'endpoint'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9_-]+$' },
    endpoint: { type: 'string', format: 'uri', maxLength: 2048 },
    authHeader: { type: 'string', maxLength: 512 },
  },
  additionalProperties: false,
} as const;

interface RegisterBody {
  name: string;
  endpoint: string;
  authHeader?: string;
}

export async function providerRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /providers/register
   * Register an external HTTP provider plugin.
   */
  fastify.post<{ Body: RegisterBody }>(
    '/providers/register',
    {
      preHandler: [requireAdmin],
      schema: { tags: ['Providers'], summary: 'Register a custom external provider plugin (admin)', body: REGISTER_SCHEMA },
    },
    async (request, reply) => {
      const { name, endpoint, authHeader } = request.body;

      // Prevent overwriting built-in chain providers
      if (PROVIDER_CHAIN.includes(name as Parameters<typeof PROVIDER_CHAIN['includes']>[0])) {
        return reply.status(409).send({ error: `Provider name "${name}" is reserved.` });
      }

      const registry = getProviderRegistry();
      registry.registerPlugin({ name, endpoint, authHeader });

      return reply.status(201).send({
        name,
        endpoint,
        registeredAt: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /providers/health
   * Returns health metrics for all tracked providers (built-in + custom).
   */
  fastify.get(
    '/providers/health',
    { preHandler: [requireApiKey], schema: { tags: ['Providers'], summary: 'Health metrics for all built-in and plugin providers (JSON)' } },
    async (_request, reply) => {
      const registry = getProviderRegistry();
      const cb = getCircuitBreaker();
      const cbStatus = cb.getStatus();
      const healthSnapshot = registry.getHealthSnapshot();

      // Build combined health view: circuit-breaker status + latency/error data
      const builtIn = PROVIDER_CHAIN.map(name => ({
        name,
        type: 'built-in' as const,
        circuitBreaker: cbStatus[name],
        metrics: healthSnapshot[name] ?? null,
      }));

      const plugins = registry.listPlugins().map(p => ({
        name: p.name,
        type: 'plugin' as const,
        endpoint: p.endpoint,
        circuitBreaker: null,
        metrics: healthSnapshot[p.name] ?? null,
      }));

      return reply.status(200).send({
        providers: [...builtIn, ...plugins],
        generatedAt: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /providers/health/view — HTML admin dashboard with time series charts.
   */
  fastify.get(
    '/providers/health/view',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Providers'],
        summary: 'Provider health monitoring dashboard (HTML)',
        security: [{ apiKey: [] }],
      },
    },
    async (_request, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(buildHealthHtml());
    },
  );

  /**
   * POST /providers/:name/disable — admin: disable a provider.
   */
  fastify.post<{ Params: { name: string }; Body: { reason?: string } }>(
    '/providers/:name/disable',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Providers'],
        summary: 'Disable a provider (admin)',
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        body: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          additionalProperties: false,
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const registry = getProviderRegistry();
      const reason = (request.body as { reason?: string }).reason ?? 'Manually disabled by admin.';
      registry.setDisabled(request.params.name, reason);
      return reply.send({
        name: request.params.name,
        disabled: true,
        disabledAt: new Date().toISOString(),
        reason,
      });
    },
  );

  /**
   * POST /providers/:name/enable — admin: re-enable a disabled provider.
   */
  fastify.post<{ Params: { name: string } }>(
    '/providers/:name/enable',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Providers'],
        summary: 'Enable a previously disabled provider (admin)',
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const registry = getProviderRegistry();
      registry.setEnabled(request.params.name);
      return reply.send({ name: request.params.name, disabled: false });
    },
  );
}

// ── HTML dashboard ────────────────────────────────────────────────────────────

function buildHealthHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Provider Health — Faultline Pro</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
  header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:1.1rem;font-weight:600;color:#58a6ff}
  .container{max-width:1100px;margin:0 auto;padding:24px}
  .refresh-bar{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 14px;font-size:.78rem;color:#7d8590;display:flex;align-items:center;gap:8px;margin-bottom:20px}
  .dot{width:6px;height:6px;border-radius:50%;background:#3fb950;flex-shrink:0;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #countdown{font-weight:600;color:#58a6ff}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
  .card.disabled{border-color:#f85149;background:#1a0d0d}
  .card-header{display:flex;align-items:center;gap:8px;margin-bottom:12px}
  .provider-name{font-size:1rem;font-weight:700;flex:1}
  .status-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .status-ok{background:#3fb950}.status-warn{background:#d29922}.status-err{background:#f85149}.status-disabled{background:#7d8590}
  .badge{display:inline-block;padding:1px 7px;border-radius:3px;font-size:.7rem;font-weight:600;border:1px solid}
  .b-ok{background:#122023;color:#3fb950;border-color:#3fb950}
  .b-warn{background:#2d2010;color:#d29922;border-color:#d29922}
  .b-err{background:#3d1a1a;color:#f85149;border-color:#f85149}
  .b-dis{background:#21262d;color:#7d8590;border-color:#7d8590}
  .metrics{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px;font-size:.82rem}
  .metric-label{color:#7d8590}
  .metric-value{font-weight:600;text-align:right}
  .sparkline{width:100%;height:40px;background:#0d1117;border-radius:4px;overflow:hidden}
  svg.spark{width:100%;height:100%}
  .disabled-reason{font-size:.75rem;color:#f85149;margin-top:8px;padding:6px 8px;background:#3d1a1a;border-radius:4px}
  .action-row{display:flex;gap:8px;margin-top:10px}
  .btn{font-size:.75rem;padding:4px 12px;border-radius:4px;border:none;cursor:pointer;font-weight:600}
  .btn-disable{background:#3d1a1a;color:#f85149;border:1px solid #f85149}
  .btn-enable{background:#122023;color:#3fb950;border:1px solid #3fb950}
  .btn:hover{opacity:.8}
  .error-msg{color:#f85149;font-size:.8rem;margin-top:6px}
  h2{font-size:.85rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
</style>
</head>
<body>
<header>
  <div style="font-size:1.2rem;font-weight:700;letter-spacing:-.02em"><span style="color:#f85149">fault</span>line pro</div>
  <h1>Provider Health Monitor</h1>
</header>
<div class="container">
  <div class="refresh-bar">
    <div class="dot"></div>
    Auto-refreshes in <span id="countdown">15</span>s &nbsp;·&nbsp;
    Auto-disable threshold: 80% errors over last 10 calls
  </div>
  <h2>Providers</h2>
  <div id="grid" class="grid"><p style="color:#7d8590;font-style:italic">Loading…</p></div>
  <div id="global-error" style="display:none;color:#f85149;margin-top:12px;font-size:.85rem"></div>
</div>
<script>
const API_KEY = new URLSearchParams(location.search).get('api_key') || '';
const headers = API_KEY ? { 'x-api-key': API_KEY } : {};

function healthScore(m) {
  if (!m) return 0;
  return Math.min(100, Math.round(m.healthScore / 10));
}

function statusClass(m, disabled) {
  if (disabled) return 'status-disabled';
  if (!m || m.totalRequests === 0) return 'status-ok';
  if (m.errorRate > 0.5) return 'status-err';
  if (m.errorRate > 0.2) return 'status-warn';
  return 'status-ok';
}

function badgeClass(m, disabled) {
  if (disabled) return 'b-dis';
  if (!m || m.totalRequests === 0) return 'b-ok';
  if (m.errorRate > 0.5) return 'b-err';
  if (m.errorRate > 0.2) return 'b-warn';
  return 'b-ok';
}

function badgeText(m, disabled) {
  if (disabled) return 'DISABLED';
  if (!m || m.totalRequests === 0) return 'HEALTHY';
  if (m.errorRate > 0.5) return 'UNHEALTHY';
  if (m.errorRate > 0.2) return 'DEGRADED';
  return 'HEALTHY';
}

function sparkline(series) {
  if (!series || series.length === 0) return '<svg class="spark"></svg>';
  const pts = series.slice(-60);
  const maxLat = Math.max(...pts.map(p => p.latencyMs), 1);
  const w = 300; const h = 40;
  const step = w / Math.max(pts.length - 1, 1);
  const dots = pts.map((p, i) => {
    const x = i * step;
    const y = h - (p.latencyMs / maxLat) * (h - 4) - 2;
    return \`\${x},\${y}\`;
  }).join(' ');
  const color = '#58a6ff';
  return \`<svg class="spark" viewBox="0 0 \${w} \${h}">
    <polyline points="\${dots}" fill="none" stroke="\${color}" stroke-width="1.5" stroke-linejoin="round"/>
    \${pts.map((p, i) => {
      const x = i * step; const y = h - (p.latencyMs / maxLat) * (h - 4) - 2;
      return \`<circle cx="\${x}" cy="\${y}" r="2" fill="\${p.success ? '#3fb950' : '#f85149'}"/>\`;
    }).join('')}
  </svg>\`;
}

async function toggleProvider(name, disable) {
  const endpoint = '/providers/' + name + (disable ? '/disable' : '/enable');
  const reason = disable ? (prompt('Reason for disabling ' + name + ':') || 'Manually disabled') : undefined;
  const body = disable && reason ? JSON.stringify({ reason }) : undefined;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      document.getElementById('global-error').textContent = 'Error: ' + (d.error || res.status);
      document.getElementById('global-error').style.display = '';
      return;
    }
    document.getElementById('global-error').style.display = 'none';
    await load();
  } catch(e) {
    document.getElementById('global-error').textContent = 'Error: ' + e.message;
    document.getElementById('global-error').style.display = '';
  }
}

async function load() {
  try {
    const d = await fetch('/providers/health', { headers }).then(r => r.json());
    const grid = document.getElementById('grid');
    if (!d.providers || d.providers.length === 0) {
      grid.innerHTML = '<p style="color:#7d8590;font-style:italic">No providers tracked yet.</p>';
      return;
    }
    grid.innerHTML = d.providers.map(p => {
      const m = p.metrics;
      const disabled = m ? m.disabled : false;
      const sc = statusClass(m, disabled);
      const bc = badgeClass(m, disabled);
      const bt = badgeText(m, disabled);
      const score = healthScore(m);
      const ts = m ? sparkline(m.timeSeries) : '';
      return \`<div class="card\${disabled ? ' disabled' : ''}">
        <div class="card-header">
          <div class="status-dot \${sc}"></div>
          <span class="provider-name">\${p.name}</span>
          <span class="badge \${bc}">\${bt}</span>
        </div>
        <div class="metrics">
          <span class="metric-label">Health Score</span><span class="metric-value">\${m ? score + '/100' : '—'}</span>
          <span class="metric-label">Error Rate</span><span class="metric-value">\${m ? (m.errorRate*100).toFixed(1) + '%' : '—'}</span>
          <span class="metric-label">Avg Latency</span><span class="metric-value">\${m ? m.avgLatencyMs.toFixed(0) + 'ms' : '—'}</span>
          <span class="metric-label">Total Calls</span><span class="metric-value">\${m ? m.totalRequests : '—'}</span>
        </div>
        <div class="sparkline">\${ts}</div>
        \${m && m.disabledReason ? '<div class="disabled-reason">'+m.disabledReason+'</div>' : ''}
        <div class="action-row">
          \${disabled
            ? '<button class="btn btn-enable" onclick="toggleProvider(\''+p.name+'\',false)">Enable</button>'
            : '<button class="btn btn-disable" onclick="toggleProvider(\''+p.name+'\',true)">Disable</button>'
          }
        </div>
      </div>\`;
    }).join('');
  } catch(e) {
    document.getElementById('global-error').textContent = 'Failed to load: ' + e.message;
    document.getElementById('global-error').style.display = '';
  }
}
let t = 15;
const cd = document.getElementById('countdown');
function tick() { t--; cd.textContent = t; if (t <= 0) { t = 15; load(); } }
load();
setInterval(tick, 1000);
</script>
</body>
</html>`;
}
