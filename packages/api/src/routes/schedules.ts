/**
 * Schedule routes (D-161)
 *
 * POST   /schedules             — create a recurring scan schedule
 * GET    /schedules             — list schedules for the authenticated key
 * GET    /schedules/:id         — get a single schedule
 * PATCH  /schedules/:id         — update cron / status / metadata
 * DELETE /schedules/:id         — delete a schedule
 * POST   /schedules/:id/trigger — manually trigger a run now
 * GET    /schedules/:id/history — paginated run history
 * GET    /schedules/view        — HTML monitoring dashboard
 */

import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import {
  getScheduleStore,
  getScheduleRunner,
  parseCron,
  type CreateScheduleInput,
  type ScheduleStatus,
  type ScheduleProvider,
} from '../store/schedules.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const CREATE_SCHEMA = {
  type: 'object',
  required: ['name', 'cron'],
  properties: {
    name:        { type: 'string', minLength: 1, maxLength: 128 },
    description: { type: 'string', maxLength: 512 },
    cron:        { type: 'string', minLength: 9, maxLength: 64 },
    text:        { type: 'string', maxLength: 200_000 },
    url:         { type: 'string', format: 'uri', maxLength: 2048 },
    provider:    { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
    notifyEmail: { type: 'string', format: 'email', maxLength: 254 },
    webhookUrl:  { type: 'string', format: 'uri', maxLength: 2048 },
    maxRuns:     { type: 'integer', minimum: 0, maximum: 100_000 },
  },
  additionalProperties: false,
} as const;

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    name:        { type: 'string', minLength: 1, maxLength: 128 },
    description: { type: 'string', maxLength: 512 },
    cron:        { type: 'string', minLength: 9, maxLength: 64 },
    notifyEmail: { type: 'string', format: 'email', maxLength: 254 },
    webhookUrl:  { type: 'string', format: 'uri', maxLength: 2048 },
    status:      { type: 'string', enum: ['active', 'paused'] },
    provider:    { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
    maxRuns:     { type: 'integer', minimum: 0, maximum: 100_000 },
  },
  additionalProperties: false,
} as const;

// ── Route handler ─────────────────────────────────────────────────────────────

export async function scheduleRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /schedules
   */
  fastify.post<{ Body: CreateScheduleInput }>(
    '/schedules',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Schedules'],
        summary: 'Create a recurring scan schedule',
        body: CREATE_SCHEMA,
      },
    },
    async (request, reply) => {
      const keyId = request.keyId ?? 'unknown';
      try {
        const schedule = getScheduleStore().create(request.body, keyId);
        return reply.status(201).send(schedule);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * GET /schedules
   */
  fastify.get(
    '/schedules',
    {
      preHandler: [requireApiKey],
      schema: { tags: ['Schedules'], summary: 'List recurring scan schedules' },
    },
    async (request, reply) => {
      const keyId = request.keyId ?? 'unknown';
      const schedules = getScheduleStore().list(keyId);
      return reply.send({ schedules, total: schedules.length });
    },
  );

  /**
   * GET /schedules/view — HTML dashboard (must be before /:id)
   */
  fastify.get(
    '/schedules/view',
    {
      preHandler: [requireApiKey],
      schema: { tags: ['Schedules'], summary: 'Recurring scan schedule dashboard (HTML)' },
    },
    async (_request, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(buildSchedulesHtml());
    },
  );

  /**
   * GET /schedules/:id
   */
  fastify.get<{ Params: { id: string } }>(
    '/schedules/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Schedules'],
        summary: 'Get a single schedule',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const schedule = getScheduleStore().get(request.params.id);
      if (!schedule) return reply.status(404).send({ error: 'Schedule not found.' });
      if (schedule.keyId !== (request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Forbidden.' });
      }
      return reply.send(schedule);
    },
  );

  /**
   * PATCH /schedules/:id
   */
  fastify.patch<{ Params: { id: string }; Body: Partial<typeof PATCH_SCHEMA['properties']> }>(
    '/schedules/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Schedules'],
        summary: 'Update a schedule',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: PATCH_SCHEMA,
      },
    },
    async (request, reply) => {
      const schedule = getScheduleStore().get(request.params.id);
      if (!schedule) return reply.status(404).send({ error: 'Schedule not found.' });
      if (schedule.keyId !== (request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Forbidden.' });
      }
      try {
        const updated = getScheduleStore().update(request.params.id, request.body as Parameters<ReturnType<typeof getScheduleStore>['update']>[1]);
        return reply.send(updated);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * DELETE /schedules/:id
   */
  fastify.delete<{ Params: { id: string } }>(
    '/schedules/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Schedules'],
        summary: 'Delete a schedule',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const schedule = getScheduleStore().get(request.params.id);
      if (!schedule) return reply.status(404).send({ error: 'Schedule not found.' });
      if (schedule.keyId !== (request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Forbidden.' });
      }
      getScheduleStore().delete(request.params.id);
      return reply.status(204).send();
    },
  );

  /**
   * POST /schedules/:id/trigger — manual immediate run
   */
  fastify.post<{ Params: { id: string } }>(
    '/schedules/:id/trigger',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Schedules'],
        summary: 'Manually trigger a schedule run immediately',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const schedule = getScheduleStore().get(request.params.id);
      if (!schedule) return reply.status(404).send({ error: 'Schedule not found.' });
      if (schedule.keyId !== (request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Forbidden.' });
      }
      // Fire-and-forget; runner will record result
      void getScheduleRunner().runSchedule(schedule).catch(() => undefined);
      return reply.status(202).send({
        message: 'Run triggered.',
        scheduleId: schedule.id,
        triggeredAt: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /schedules/:id/history
   */
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/schedules/:id/history',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Schedules'],
        summary: 'Get run history for a schedule',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: { limit: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const schedule = getScheduleStore().get(request.params.id);
      if (!schedule) return reply.status(404).send({ error: 'Schedule not found.' });
      if (schedule.keyId !== (request.keyId ?? 'unknown')) {
        return reply.status(403).send({ error: 'Forbidden.' });
      }
      const limit = Math.min(parseInt(request.query.limit ?? '20', 10) || 20, 100);
      return reply.send({
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        history: schedule.history.slice(0, limit),
        total: schedule.history.length,
      });
    },
  );
}

// ── HTML dashboard ─────────────────────────────────────────────────────────────

function buildSchedulesHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scan Schedules — Faultline Pro</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
  header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:1.1rem;font-weight:600;color:#58a6ff}
  .container{max-width:1200px;margin:0 auto;padding:24px}
  .refresh-bar{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 14px;font-size:.78rem;color:#7d8590;display:flex;align-items:center;gap:8px;margin-bottom:20px}
  .dot{width:6px;height:6px;border-radius:50%;background:#3fb950;flex-shrink:0;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #countdown{font-weight:600;color:#58a6ff}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{text-align:left;padding:8px 12px;border-bottom:2px solid #30363d;color:#8b949e;text-transform:uppercase;font-size:.72rem;letter-spacing:.05em}
  td{padding:8px 12px;border-bottom:1px solid #21262d;vertical-align:top}
  tr:hover td{background:#161b22}
  .badge{display:inline-block;padding:1px 8px;border-radius:3px;font-size:.7rem;font-weight:600;border:1px solid}
  .b-active{background:#122023;color:#3fb950;border-color:#3fb950}
  .b-paused{background:#2d2010;color:#d29922;border-color:#d29922}
  .b-completed{background:#21262d;color:#58a6ff;border-color:#58a6ff}
  .b-error{background:#3d1a1a;color:#f85149;border-color:#f85149}
  .risk-low{color:#3fb950}.risk-medium{color:#d29922}.risk-high{color:#f85149}.risk-critical{color:#ff7b72}
  .mono{font-family:monospace;font-size:.8rem;color:#8b949e}
  .btn{font-size:.72rem;padding:3px 10px;border-radius:4px;border:none;cursor:pointer;font-weight:600;margin-right:4px}
  .btn-trigger{background:#1a2d1a;color:#3fb950;border:1px solid #3fb950}
  .btn-pause{background:#2d2010;color:#d29922;border:1px solid #d29922}
  .btn-delete{background:#3d1a1a;color:#f85149;border:1px solid #f85149}
  .btn:hover{opacity:.8}
  h2{font-size:.85rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
  .empty{color:#7d8590;font-style:italic;padding:24px 0;text-align:center}
  #error-msg{color:#f85149;font-size:.82rem;margin-top:12px;display:none}
  .summary-bar{display:flex;gap:20px;margin-bottom:20px}
  .stat{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px 16px;flex:1;text-align:center}
  .stat-value{font-size:1.5rem;font-weight:700;color:#58a6ff}
  .stat-label{font-size:.72rem;color:#7d8590;margin-top:2px}
</style>
</head>
<body>
<header>
  <div style="font-size:1.2rem;font-weight:700;letter-spacing:-.02em"><span style="color:#f85149">fault</span>line pro</div>
  <h1>Scan Schedules</h1>
</header>
<div class="container">
  <div class="refresh-bar">
    <div class="dot"></div>
    Auto-refreshes in <span id="countdown">15</span>s
    &nbsp;·&nbsp; Pass <code>?api_key=YOUR_KEY</code> in the URL to authenticate.
  </div>
  <div class="summary-bar" id="summary-bar">
    <div class="stat"><div class="stat-value" id="stat-total">—</div><div class="stat-label">Total</div></div>
    <div class="stat"><div class="stat-value" id="stat-active">—</div><div class="stat-label">Active</div></div>
    <div class="stat"><div class="stat-value" id="stat-paused">—</div><div class="stat-label">Paused</div></div>
    <div class="stat"><div class="stat-value" id="stat-runs">—</div><div class="stat-label">Total Runs</div></div>
  </div>
  <h2>Schedules</h2>
  <div id="table-wrap"><p class="empty">Loading…</p></div>
  <div id="error-msg"></div>
</div>
<script>
const API_KEY = new URLSearchParams(location.search).get('api_key') || '';
const headers = API_KEY ? { 'x-api-key': API_KEY } : {};

function riskClass(r) {
  if (!r || r === 'unknown') return '';
  return 'risk-' + r.toLowerCase();
}

function statusBadge(s) {
  const cls = { active: 'b-active', paused: 'b-paused', completed: 'b-completed', error: 'b-error' }[s] || 'b-paused';
  return '<span class="badge ' + cls + '">' + s.toUpperCase() + '</span>';
}

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

async function trigger(id) {
  try {
    const r = await fetch('/schedules/' + id + '/trigger', { method: 'POST', headers });
    if (!r.ok) { const d = await r.json().catch(()=>({})); showError('Trigger failed: ' + (d.error || r.status)); return; }
    hideError();
    await load();
  } catch(e) { showError('Error: ' + e.message); }
}

async function togglePause(id, isPaused) {
  const status = isPaused ? 'active' : 'paused';
  try {
    const r = await fetch('/schedules/' + id, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) { const d = await r.json().catch(()=>({})); showError('Update failed: ' + (d.error || r.status)); return; }
    hideError();
    await load();
  } catch(e) { showError('Error: ' + e.message); }
}

async function del(id) {
  if (!confirm('Delete this schedule? This cannot be undone.')) return;
  try {
    const r = await fetch('/schedules/' + id, { method: 'DELETE', headers });
    if (!r.ok && r.status !== 204) { const d = await r.json().catch(()=>({})); showError('Delete failed: ' + (d.error || r.status)); return; }
    hideError();
    await load();
  } catch(e) { showError('Error: ' + e.message); }
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg; el.style.display = '';
}
function hideError() {
  document.getElementById('error-msg').style.display = 'none';
}

async function load() {
  try {
    const d = await fetch('/schedules', { headers }).then(r => r.json());
    const scheds = d.schedules || [];
    document.getElementById('stat-total').textContent = scheds.length;
    document.getElementById('stat-active').textContent = scheds.filter(s => s.status === 'active').length;
    document.getElementById('stat-paused').textContent = scheds.filter(s => s.status === 'paused').length;
    document.getElementById('stat-runs').textContent = scheds.reduce((acc, s) => acc + (s.runCount || 0), 0);

    const wrap = document.getElementById('table-wrap');
    if (scheds.length === 0) {
      wrap.innerHTML = '<p class="empty">No schedules found. Create one via POST /schedules.</p>';
      return;
    }
    wrap.innerHTML = '<table><thead><tr>' +
      '<th>Name</th><th>Cron</th><th>Source</th><th>Status</th>' +
      '<th>Last Run</th><th>Next Run</th><th>Runs</th><th>Last Risk</th><th>Actions</th>' +
      '</tr></thead><tbody>' +
      scheds.map(s => {
        const isPaused = s.status === 'paused';
        const risk = s.lastResult ? s.lastResult.overallRisk : null;
        const src = s.url ? ('<span title="' + s.url + '">URL</span>') : 'text';
        return '<tr>' +
          '<td><strong>' + s.name + '</strong>' + (s.description ? '<br><span style="color:#7d8590;font-size:.78rem">' + s.description + '</span>' : '') + '</td>' +
          '<td class="mono">' + s.cron + '</td>' +
          '<td>' + src + '</td>' +
          '<td>' + statusBadge(s.status) + '</td>' +
          '<td style="font-size:.78rem">' + fmt(s.lastRunAt) + '</td>' +
          '<td style="font-size:.78rem">' + fmt(s.nextRunAt) + '</td>' +
          '<td>' + s.runCount + '</td>' +
          '<td>' + (risk ? '<span class="' + riskClass(risk) + '">' + risk + '</span>' : '—') + '</td>' +
          '<td>' +
            '<button class="btn btn-trigger" onclick="trigger(\\'' + s.id + '\\')">Run Now</button>' +
            '<button class="btn btn-pause" onclick="togglePause(\\'' + s.id + '\\',' + isPaused + ')">' + (isPaused ? 'Resume' : 'Pause') + '</button>' +
            '<button class="btn btn-delete" onclick="del(\\'' + s.id + '\\')">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  } catch(e) {
    showError('Failed to load: ' + e.message);
  }
}

let t = 15;
const cd = document.getElementById('countdown');
function tick() { t--; cd.textContent = t; if (t <= 0) { t = 15; void load(); } }
load();
setInterval(tick, 1000);
</script>
</body>
</html>`;
}
