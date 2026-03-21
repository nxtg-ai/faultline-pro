import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireApiKey, resolveRequestTenantId } from '../plugins/auth.js';
import { getWebhookStore, getWebhookTestHistory, getWebhookDeliveryLog, sendTestWebhook, SAMPLE_PAYLOADS } from '../store/webhooks.js';
import type { WebhookEvent } from '../store/webhooks.js';

const VALID_EVENTS: WebhookEvent[] = ['scan.complete', 'scan.failed', 'claim.verdict_changed', 'compliance.deadline_approaching'];

const CREATE_BODY_SCHEMA = {
  type: 'object',
  required: ['url', 'events'],
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 2048 },
    events: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: VALID_EVENTS },
    },
    secret:       { type: 'string', minLength: 1, maxLength: 128 },
    maxAttempts:  { type: 'integer', minimum: 1, maximum: 5 },
    retryDelayMs: { type: 'integer', minimum: 0, maximum: 30000 },
  },
  additionalProperties: false,
} as const;

interface CreateWebhookBody {
  url: string;
  events: WebhookEvent[];
  secret?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CreateWebhookBody }>(
    '/webhooks',
    { preHandler: requireAdmin, schema: { tags: ['Webhooks'], summary: 'Register a new webhook endpoint and event subscription', body: CREATE_BODY_SCHEMA } },
    async (request, reply) => {
      const { url, events, secret, maxAttempts, retryDelayMs } = request.body;
      const tenantId = resolveRequestTenantId(request.keyId);
      const entry = getWebhookStore().create(url, events, secret, tenantId, maxAttempts, retryDelayMs);
      return reply.status(201).send(entry);
    },
  );

  fastify.get<{ Querystring: { tenantId?: string } }>(
    '/webhooks',
    { preHandler: requireAdmin, schema: { tags: ['Webhooks'], summary: 'List all registered webhook subscriptions' } },
    async (request, reply) => {
      return reply.status(200).send(getWebhookStore().list(request.query.tenantId));
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/webhooks/:id',
    { preHandler: requireAdmin, schema: { tags: ['Webhooks'], summary: 'Delete a webhook subscription by ID' } },
    async (request, reply) => {
      const deleted = getWebhookStore().delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Webhook not found.' });
      }
      return reply.status(204).send();
    },
  );

  // ── Test tool ──────────────────────────────────────────────────────────────

  // GET /webhooks/test — HTML tester page (public)
  fastify.get(
    '/webhooks/test',
    { schema: { tags: ['Webhooks'], summary: 'Webhook test tool (HTML)', security: [] } },
    async (_request, reply) => {
      const registeredHooks = getWebhookStore().list();
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(buildTestHtml(registeredHooks));
    },
  );

  // POST /webhooks/test — send sample payload to any URL
  fastify.post<{ Body: { url: string; event?: string; secret?: string } }>(
    '/webhooks/test',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Webhooks'],
        summary: 'Send a test payload to any webhook URL',
        body: {
          type: 'object',
          required: ['url'],
          properties: {
            url:    { type: 'string', minLength: 1, maxLength: 2048 },
            event:  { type: 'string', enum: Object.keys(SAMPLE_PAYLOADS) },
            secret: { type: 'string', maxLength: 256 },
          },
          additionalProperties: false,
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const { url, event = 'scan.complete', secret = null } = request.body;
      try { new URL(url); } catch { return reply.status(400).send({ error: 'url must be a valid URL.' }); }
      const result = await sendTestWebhook(url, event, secret ?? null);
      return reply.status(200).send(result);
    },
  );

  // POST /webhooks/test/:id — send sample payload to a registered webhook's URL
  fastify.post<{ Params: { id: string }; Body: { event?: string } }>(
    '/webhooks/test/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Webhooks'],
        summary: 'Send a test payload to a registered webhook',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: { event: { type: 'string', enum: Object.keys(SAMPLE_PAYLOADS) } },
          additionalProperties: false,
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const webhook = getWebhookStore().getById(request.params.id);
      if (!webhook) return reply.status(404).send({ error: 'Webhook not found.' });
      const event = request.body?.event ?? webhook.events[0] ?? 'scan.complete';
      const result = await sendTestWebhook(webhook.url, event, webhook.secret, webhook.id);
      return reply.status(200).send(result);
    },
  );

  // GET /webhooks/test/history — test delivery history
  fastify.get<{ Querystring: { webhookId?: string } }>(
    '/webhooks/test/history',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Webhooks'],
        summary: 'Webhook test delivery history',
        querystring: {
          type: 'object',
          properties: { webhookId: { type: 'string' } },
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const records = getWebhookTestHistory().list(request.query.webhookId);
      return reply.send({ total: records.length, records });
    },
  );

  // GET /webhooks/deliveries — recent real delivery attempts (all webhooks)
  fastify.get<{ Querystring: { limit?: string } }>(
    '/webhooks/deliveries',
    {
      preHandler: requireAdmin,
      schema: {
        tags: ['Webhooks'],
        summary: 'Recent webhook delivery attempts across all subscriptions. Shows status, latency, and error for each attempt.',
        querystring: {
          type: 'object',
          properties: { limit: { type: 'string', pattern: '^[0-9]+$' } },
        },
      },
    },
    async (request, reply) => {
      const limit   = Math.min(500, Math.max(1, parseInt(request.query.limit ?? '100', 10)));
      const records = getWebhookDeliveryLog().list(undefined, limit);
      const failedCount = records.filter((r) => !r.delivered).length;
      return reply.send({ total: records.length, failedCount, records });
    },
  );

  // GET /webhooks/deliveries/view — HTML delivery log dashboard
  fastify.get<{ Querystring: { limit?: string } }>(
    '/webhooks/deliveries/view',
    {
      preHandler: requireAdmin,
      schema: { tags: ['Webhooks'], summary: 'Webhook delivery log dashboard (HTML)' },
    },
    async (request, reply) => {
      const limit   = Math.min(500, Math.max(1, parseInt(request.query.limit ?? '100', 10)));
      const records = getWebhookDeliveryLog().list(undefined, limit);
      const total       = records.length;
      const delivered   = records.filter((r) => r.delivered).length;
      const failed      = total - delivered;
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(buildDeliveryDashboardHtml(records, total, delivered, failed));
    },
  );

  // GET /webhooks/:id/deliveries — delivery history for a specific webhook
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/webhooks/:id/deliveries',
    {
      preHandler: requireAdmin,
      schema: {
        tags: ['Webhooks'],
        summary: 'Delivery history for a specific webhook subscription.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: { limit: { type: 'string', pattern: '^[0-9]+$' } },
        },
      },
    },
    async (request, reply) => {
      const { id }  = request.params;
      const webhook = getWebhookStore().getById(id);
      if (!webhook) return reply.status(404).send({ error: 'Webhook not found', code: 'NOT_FOUND' });
      const limit   = Math.min(500, Math.max(1, parseInt(request.query.limit ?? '100', 10)));
      const records = getWebhookDeliveryLog().list(id, limit);
      const failedCount = records.filter((r) => !r.delivered).length;
      return reply.send({ webhookId: id, total: records.length, failedCount, records });
    },
  );
}

// ── HTML delivery dashboard ───────────────────────────────────────────────────

import type { WebhookDeliveryRecord } from '../store/webhooks.js';
import { esc } from '../lib/html.js';

function buildDeliveryDashboardHtml(
  records: WebhookDeliveryRecord[],
  total: number,
  delivered: number,
  failed: number,
): string {
  const successRate = total > 0 ? Math.round((delivered / total) * 100) : 100;

  const rows = records.length === 0
    ? `<tr><td colspan="7" style="text-align:center;padding:24px;color:#7d8590">No delivery records yet — records appear after webhooks fire.</td></tr>`
    : records.map((r) => {
        const chip = r.delivered
          ? `<span class="chip delivered">DELIVERED</span>`
          : `<span class="chip failed">FAILED</span>`;
        const attempt = `<span class="attempt">#${r.attempt}</span>`;
        const latency = `${r.latencyMs}ms`;
        const errCell = r.error ? `<span class="err-msg">${esc(r.error)}</span>` : `<span style="color:#3fb950">—</span>`;
        const status  = r.statusCode != null ? String(r.statusCode) : '—';
        const ts      = new Date(r.timestamp).toISOString().replace('T', ' ').slice(0, 19);
        return `<tr>
          <td class="mono">${esc(r.webhookId.slice(0, 8))}</td>
          <td class="mono">${esc(r.event)}</td>
          <td>${attempt}</td>
          <td>${chip}</td>
          <td>${status}</td>
          <td>${latency}</td>
          <td>${errCell}</td>
          <td style="color:#7d8590;font-size:.75rem">${ts}</td>
        </tr>`;
      }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webhook Delivery Log — Faultline Pro</title>
<meta http-equiv="refresh" content="30">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
  header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:1.1rem;font-weight:600;color:#58a6ff}
  .container{max-width:1200px;margin:0 auto;padding:24px}
  .stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
  .stat-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
  .stat-card .label{font-size:.75rem;color:#7d8590;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
  .stat-card .value{font-size:1.8rem;font-weight:700;color:#58a6ff}
  .stat-card .value.ok{color:#3fb950}
  .stat-card .value.bad{color:#f85149}
  h2{font-size:.9rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;font-size:.83rem}
  th{text-align:left;padding:8px 12px;background:#161b22;color:#7d8590;border-bottom:1px solid #30363d;font-weight:500;font-size:.75rem;text-transform:uppercase}
  td{padding:8px 12px;border-bottom:1px solid #21262d;vertical-align:middle}
  .mono{font-family:'Fira Code','Courier New',monospace;font-size:.78rem;color:#79c0ff}
  .chip{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.72rem;font-weight:700}
  .chip.delivered{background:#122023;color:#3fb950;border:1px solid #3fb950}
  .chip.failed{background:#3d1a1a;color:#f85149;border:1px solid #f85149}
  .attempt{display:inline-block;padding:1px 6px;border-radius:3px;background:#21262d;color:#8b949e;font-size:.75rem;font-family:'Fira Code','Courier New',monospace}
  .err-msg{color:#f85149;font-size:.78rem;font-family:'Fira Code','Courier New',monospace;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block}
  .refresh-note{font-size:.75rem;color:#7d8590;text-align:right;margin-bottom:8px}
</style>
</head>
<body>
<header>
  <div style="font-size:1.2rem;font-weight:700;letter-spacing:-.02em"><span style="color:#f85149">fault</span>line pro</div>
  <h1>Webhook Delivery Log</h1>
</header>
<div class="container">

  <div class="stat-row">
    <div class="stat-card"><div class="label">Total Attempts</div><div class="value">${total}</div></div>
    <div class="stat-card"><div class="label">Delivered</div><div class="value ok">${delivered}</div></div>
    <div class="stat-card"><div class="label">Failed</div><div class="value ${failed > 0 ? 'bad' : 'ok'}">${failed}</div></div>
    <div class="stat-card"><div class="label">Success Rate</div><div class="value ${successRate < 80 ? 'bad' : 'ok'}">${successRate}%</div></div>
  </div>

  <div class="refresh-note">Auto-refreshes every 30s</div>
  <h2>Recent Delivery Attempts (last ${total})</h2>
  <table>
    <thead>
      <tr>
        <th>Webhook</th><th>Event</th><th>Attempt</th><th>Status</th><th>HTTP</th><th>Latency</th><th>Error</th><th>Time</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

</div>
</body>
</html>`;
}

// ── HTML tester page ──────────────────────────────────────────────────────────

function buildTestHtml(registeredHooks: Array<{ id: string; url: string; events: string[] }>): string {
  const eventOptions = Object.keys(SAMPLE_PAYLOADS).map(e => `<option value="${e}">${e}</option>`).join('');
  const hookOptions = registeredHooks.length
    ? registeredHooks.map(h => `<option value="${h.id}">${h.url} (${h.events.join(', ')})</option>`).join('')
    : '<option value="">— no webhooks registered —</option>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webhook Test Tool — Faultline Pro</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
  header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:1.1rem;font-weight:600;color:#58a6ff}
  .container{max-width:900px;margin:0 auto;padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media(max-width:700px){.container{grid-template-columns:1fr}}
  .panel{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px}
  .panel h2{font-size:.85rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:16px}
  label{display:block;font-size:.8rem;color:#8b949e;margin-bottom:4px;margin-top:12px}
  label:first-of-type{margin-top:0}
  input,select,textarea{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;color:#e6edf3;font-size:.85rem;font-family:inherit}
  input:focus,select:focus,textarea:focus{outline:none;border-color:#58a6ff}
  textarea{font-family:'Fira Code','Courier New',monospace;font-size:.78rem;resize:vertical;min-height:100px}
  button{margin-top:16px;width:100%;padding:10px;background:#238636;border:none;border-radius:6px;color:#fff;font-size:.9rem;font-weight:600;cursor:pointer}
  button:hover{background:#2ea043}
  button:disabled{background:#21262d;color:#7d8590;cursor:not-allowed}
  .result{margin-top:20px;display:none}
  .result.visible{display:block}
  .status-line{display:flex;gap:10px;align-items:center;margin-bottom:10px}
  .status-badge{padding:2px 10px;border-radius:4px;font-size:.8rem;font-weight:700}
  .ok{background:#122023;color:#3fb950;border:1px solid #3fb950}
  .error{background:#3d1a1a;color:#f85149;border:1px solid #f85149}
  .latency{font-size:.8rem;color:#7d8590}
  pre{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:12px;font-size:.75rem;color:#79c0ff;overflow-x:auto;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto}
  .tabs{display:flex;gap:4px;margin-bottom:8px}
  .tab{padding:4px 12px;background:#21262d;border:1px solid #30363d;border-radius:4px;font-size:.75rem;cursor:pointer;color:#7d8590}
  .tab.active{background:#161b22;color:#e6edf3;border-color:#58a6ff}
  .tab-content{display:none}
  .tab-content.active{display:block}
  .note{font-size:.78rem;color:#7d8590;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px;margin-top:10px}
  .separator{text-align:center;color:#30363d;font-size:.75rem;margin:12px 0;position:relative}
  .separator::before{content:'';position:absolute;left:0;top:50%;width:45%;height:1px;background:#30363d}
  .separator::after{content:'';position:absolute;right:0;top:50%;width:45%;height:1px;background:#30363d}
</style>
</head>
<body>
<header>
  <div style="font-size:1.2rem;font-weight:700;letter-spacing:-.02em"><span style="color:#f85149">fault</span>line pro</div>
  <h1>Webhook Test Tool</h1>
</header>
<div class="container">

  <!-- Left: custom URL test -->
  <div class="panel">
    <h2>Test Any URL</h2>
    <label>Webhook URL</label>
    <input type="url" id="custom-url" placeholder="https://your-server.com/webhook">
    <label>Event Type</label>
    <select id="custom-event">${eventOptions}</select>
    <label>Secret (optional — adds X-Faultline-Signature header)</label>
    <input type="text" id="custom-secret" placeholder="your-webhook-secret">
    <label>API Key (required)</label>
    <input type="text" id="custom-apikey" placeholder="your-faultline-api-key">
    <button id="custom-btn" onclick="sendCustom()">Send Test Payload</button>
    <div class="result" id="custom-result"></div>
  </div>

  <!-- Right: registered webhook test -->
  <div class="panel">
    <h2>Test Registered Webhook</h2>
    <label>Registered Webhook</label>
    <select id="reg-hook">${hookOptions}</select>
    <label>Override Event Type (optional)</label>
    <select id="reg-event"><option value="">— use webhook's first event —</option>${eventOptions}</select>
    <label>API Key (required)</label>
    <input type="text" id="reg-apikey" placeholder="your-faultline-api-key">
    <button id="reg-btn" onclick="sendRegistered()" ${registeredHooks.length === 0 ? 'disabled' : ''}>Send Test Payload</button>
    <div class="result" id="reg-result"></div>
  </div>

</div>

<script>
function renderResult(containerId, data) {
  const el = document.getElementById(containerId);
  const ok = data.delivered;
  const errMsg = data.error ? data.error : (!ok && data.statusCode ? 'HTTP ' + data.statusCode + ' ' + (data.statusText ?? '') : '');
  el.innerHTML =
    '<div class="status-line">' +
    '<span class="status-badge ' + (ok ? 'ok' : 'error') + '">' + (ok ? '✓ DELIVERED' : '✗ FAILED') + '</span>' +
    (data.statusCode ? '<span class="latency">HTTP ' + data.statusCode + '</span>' : '') +
    '<span class="latency">' + data.latencyMs + 'ms</span>' +
    '</div>' +
    (errMsg ? '<div class="note" style="color:#f85149;margin-bottom:8px">' + escHtml(errMsg) + '</div>' : '') +
    '<div class="tabs">' +
    '<div class="tab active" onclick="switchTab(this, \\'body-' + containerId + '\\')">Response Body</div>' +
    '<div class="tab" onclick="switchTab(this, \\'headers-' + containerId + '\\')">Response Headers</div>' +
    '<div class="tab" onclick="switchTab(this, \\'sent-' + containerId + '\\')">Sent Payload</div>' +
    '</div>' +
    '<div class="tab-content active" id="body-' + containerId + '">' +
    '<pre>' + escHtml(data.responseBody ?? '(no response body)') + '</pre>' +
    '</div>' +
    '<div class="tab-content" id="headers-' + containerId + '">' +
    '<pre>' + escHtml(JSON.stringify(data.responseHeaders, null, 2)) + '</pre>' +
    '</div>' +
    '<div class="tab-content" id="sent-' + containerId + '">' +
    '<pre>' + escHtml(JSON.stringify({ url: data.url, event: data.event, signature: data.signatureHeader }, null, 2)) + '</pre>' +
    '</div>';
  el.classList.add('visible');
}
function switchTab(btn, contentId) {
  const panel = btn.closest('.panel') ?? btn.closest('.result');
  panel.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  panel.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(contentId)?.classList.add('active');
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
async function sendCustom() {
  const url = document.getElementById('custom-url').value.trim();
  const event = document.getElementById('custom-event').value;
  const secret = document.getElementById('custom-secret').value.trim();
  const apikey = document.getElementById('custom-apikey').value.trim();
  if (!url) return alert('Enter a webhook URL first.');
  if (!apikey) return alert('Enter your Faultline API key.');
  document.getElementById('custom-btn').disabled = true;
  try {
    const body = { url, event };
    if (secret) body.secret = secret;
    const res = await fetch('/webhooks/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apikey },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    renderResult('custom-result', data);
  } catch(e) { alert('Request failed: ' + e.message); }
  document.getElementById('custom-btn').disabled = false;
}
async function sendRegistered() {
  const hookId = document.getElementById('reg-hook').value;
  const event = document.getElementById('reg-event').value;
  const apikey = document.getElementById('reg-apikey').value.trim();
  if (!hookId) return alert('No registered webhooks found. Register one first via POST /webhooks.');
  if (!apikey) return alert('Enter your Faultline API key.');
  document.getElementById('reg-btn').disabled = true;
  try {
    const body = event ? { event } : {};
    const res = await fetch('/webhooks/test/' + hookId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apikey },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    renderResult('reg-result', data);
  } catch(e) { alert('Request failed: ' + e.message); }
  document.getElementById('reg-btn').disabled = false;
}
</script>
</body>
</html>`;
}
