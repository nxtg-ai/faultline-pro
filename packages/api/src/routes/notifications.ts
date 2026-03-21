import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import {
  getNotificationStore,
  ALL_EVENT_TYPES,
  EVENT_CATALOGUE,
} from '../store/notifications.js';
import type { NotificationEventType } from '../store/notifications.js';
import { getAnalyticsStore } from '../store/analytics.js';

// ── Validation ────────────────────────────────────────────────────────────────

const PREFS_BODY_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: { type: 'string', enum: ALL_EVENT_TYPES },
      maxItems: ALL_EVENT_TYPES.length,
    },
    webhookUrl: { type: ['string', 'null'], maxLength: 2048 },
    email:      { type: ['string', 'null'], maxLength: 320 },
  },
  additionalProperties: false,
} as const;

interface PrefsBody {
  events?:     string[];
  webhookUrl?: string | null;
  email?:      string | null;
}

// ── Weekly summary builder ────────────────────────────────────────────────────

function buildWeeklySummaryPayload(keyId: string): Record<string, unknown> {
  const analytics = getAnalyticsStore();
  const stats = (analytics as any).getSummary ? (analytics as any).getSummary() : { totalScans: 0 };
  return {
    keyId,
    week:      new Date().toISOString().slice(0, 10),
    totalScans: (stats as Record<string, unknown>).totalScans ?? 0,
    note:      'Weekly summary — configure FAULTLINE_NOTIFY_WEBHOOK or set webhookUrl to receive delivery.',
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export async function notificationRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /notifications/prefs — list all prefs (admin view)
  fastify.get(
    '/notifications/prefs',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Monitoring'],
        summary: 'List all notification preferences (admin)',
        security: [{ apiKey: [] }],
      },
    },
    async (_request, reply) => {
      return reply.send({ prefs: getNotificationStore().listPrefs(), eventTypes: ALL_EVENT_TYPES });
    },
  );

  // GET /notifications/prefs/:keyId — get prefs for a specific key
  fastify.get<{ Params: { keyId: string } }>(
    '/notifications/prefs/:keyId',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Monitoring'],
        summary: 'Get notification preferences for an API key',
        params: {
          type: 'object',
          properties: { keyId: { type: 'string' } },
          required: ['keyId'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const prefs = getNotificationStore().getPrefs(request.params.keyId);
      if (!prefs) {
        return reply.status(404).send({
          error: 'No notification preferences found for this key.',
          availableEvents: ALL_EVENT_TYPES,
        });
      }
      return reply.send(prefs);
    },
  );

  // PUT /notifications/prefs/:keyId — create or update prefs
  fastify.put<{ Params: { keyId: string }; Body: PrefsBody }>(
    '/notifications/prefs/:keyId',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Monitoring'],
        summary: 'Set notification preferences for an API key',
        params: {
          type: 'object',
          properties: { keyId: { type: 'string' } },
          required: ['keyId'],
        },
        body: PREFS_BODY_SCHEMA,
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const { keyId } = request.params;
      const { events = ALL_EVENT_TYPES, webhookUrl = null, email = null } = request.body;

      // Validate event types
      const invalid = events.filter(e => !(ALL_EVENT_TYPES as string[]).includes(e));
      if (invalid.length > 0) {
        return reply.status(400).send({ error: `Unknown event types: ${invalid.join(', ')}`, validTypes: ALL_EVENT_TYPES });
      }

      // Validate webhookUrl format
      if (webhookUrl !== null) {
        try {
          const u = new URL(webhookUrl);
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        } catch {
          return reply.status(400).send({ error: 'webhookUrl must be a valid http/https URL.' });
        }
      }

      const existing = getNotificationStore().getPrefs(keyId);
      const prefs = getNotificationStore().setPrefs(keyId, events as NotificationEventType[], webhookUrl, email);
      return reply.status(existing ? 200 : 201).send(prefs);
    },
  );

  // DELETE /notifications/prefs/:keyId — remove prefs
  fastify.delete<{ Params: { keyId: string } }>(
    '/notifications/prefs/:keyId',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Monitoring'],
        summary: 'Delete notification preferences for an API key',
        params: {
          type: 'object',
          properties: { keyId: { type: 'string' } },
          required: ['keyId'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const deleted = getNotificationStore().deletePrefs(request.params.keyId);
      if (!deleted) return reply.status(404).send({ error: 'No preferences found for this key.' });
      return reply.status(204).send();
    },
  );

  // GET /notifications/history — full history (admin)
  fastify.get<{ Querystring: { keyId?: string; limit?: string; tenantId?: string } }>(
    '/notifications/history',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Monitoring'],
        summary: 'Notification delivery history',
        querystring: {
          type: 'object',
          properties: {
            keyId:    { type: 'string' },
            limit:    { type: 'string' },
            tenantId: { type: 'string' },
          },
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const limit = Math.min(500, Number(request.query.limit ?? 100));
      const records = getNotificationStore().getHistory(request.query.keyId, limit, request.query.tenantId);
      return reply.send({ total: records.length, records });
    },
  );

  // POST /notifications/test — send a test notification to a key
  fastify.post<{ Params: { keyId: string } }>(
    '/notifications/test/:keyId',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Monitoring'],
        summary: 'Send a test notification to verify webhook delivery',
        params: {
          type: 'object',
          properties: { keyId: { type: 'string' } },
          required: ['keyId'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const prefs = getNotificationStore().getPrefs(request.params.keyId);
      if (!prefs) {
        return reply.status(404).send({ error: 'No notification preferences found for this key. Use PUT /notifications/prefs/:keyId first.' });
      }
      await getNotificationStore().dispatch(
        'scan.failed',
        { test: true, message: 'This is a test notification from Faultline Pro.', provider: 'test', error: 'test-event', keyId: request.params.keyId },
        request.params.keyId,
      );
      const latest = getNotificationStore().getHistory(request.params.keyId, 1)[0];
      return reply.status(200).send({
        sent: true,
        delivered: latest?.delivered ?? false,
        deliveryUrl: latest?.deliveryUrl ?? null,
        error: latest?.error ?? null,
      });
    },
  );

  // GET /notifications/events — list available event types with descriptions
  fastify.get(
    '/notifications/events',
    {
      schema: {
        tags: ['Monitoring'],
        summary: 'List available notification event types (public)',
        security: [],
      },
    },
    async (_request, reply) => {
      return reply.send({
        eventTypes: ALL_EVENT_TYPES.map(type => ({ type, ...EVENT_CATALOGUE[type] })),
        deliveryModel: 'webhook',
        note: 'Set webhookUrl in your preferences, or configure FAULTLINE_NOTIFY_WEBHOOK globally. The webhook receives a JSON POST with { event, keyId, ...payload }.',
      });
    },
  );

  // GET /notifications — HTML summary page
  fastify.get(
    '/notifications',
    {
      schema: {
        tags: ['Monitoring'],
        summary: 'Notification system overview (HTML)',
        security: [],
      },
    },
    async (_request, reply) => {
      const evtTypes = ALL_EVENT_TYPES;
      const prefsCount = getNotificationStore().listPrefs().length;
      const recentHistory = getNotificationStore().getHistory(undefined, 10);
      const deliveredCount = recentHistory.filter(r => r.delivered).length;

      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notifications — Faultline Pro</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
  header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:1.1rem;font-weight:600;color:#58a6ff}
  .container{max-width:960px;margin:0 auto;padding:24px}
  .stat-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}
  .stat-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
  .stat-card .label{font-size:.75rem;color:#7d8590;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
  .stat-card .value{font-size:1.8rem;font-weight:700;color:#58a6ff}
  h2{font-size:.9rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
  .section{margin-bottom:28px}
  .event-grid{display:grid;gap:8px}
  .event-card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px 16px;display:flex;gap:12px;align-items:flex-start}
  .event-type{font-family:'Fira Code','Courier New',monospace;font-size:.8rem;color:#79c0ff;flex-shrink:0;min-width:190px}
  .event-desc{font-size:.85rem;color:#7d8590}
  .api-table{width:100%;border-collapse:collapse;font-size:.83rem;margin-bottom:16px}
  .api-table th{text-align:left;padding:8px 12px;background:#161b22;color:#7d8590;border-bottom:1px solid #30363d;font-weight:500;font-size:.75rem;text-transform:uppercase}
  .api-table td{padding:8px 12px;border-bottom:1px solid #21262d}
  .mono{font-family:'Fira Code','Courier New',monospace;font-size:.78rem;color:#79c0ff}
  .method{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:700;margin-right:4px}
  .get{background:#1a2e1a;color:#3fb950;border:1px solid #3fb950}
  .put{background:#1a2a3d;color:#58a6ff;border:1px solid #58a6ff}
  .post{background:#1a2a3d;color:#58a6ff;border:1px solid #58a6ff}
  .del{background:#3d1a1a;color:#f85149;border:1px solid #f85149}
  .note{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px 16px;font-size:.83rem;color:#7d8590;margin-bottom:20px}
  .note strong{color:#d29922}
</style>
</head>
<body>
<header>
  <div style="font-size:1.2rem;font-weight:700;letter-spacing:-.02em"><span style="color:#f85149">fault</span>line pro</div>
  <h1>Notification System</h1>
</header>
<div class="container">

  <div class="stat-row">
    <div class="stat-card"><div class="label">Configured Keys</div><div class="value">${prefsCount}</div></div>
    <div class="stat-card"><div class="label">Event Types</div><div class="value">${evtTypes.length}</div></div>
    <div class="stat-card"><div class="label">Recent Delivered</div><div class="value">${deliveredCount}</div></div>
  </div>

  <div class="note">
    <strong>Delivery model:</strong> All notifications are delivered via webhook POST (JSON).
    Set <code>webhookUrl</code> per API key, or configure <code>FAULTLINE_NOTIFY_WEBHOOK</code> globally.
    Connect to Resend, SendGrid, Postmark, Slack, Zapier, or Make.com for email delivery.
  </div>

  <div class="section">
    <h2>Available Event Types</h2>
    <div class="event-grid">
      ${evtTypes.map(t => `<div class="event-card"><span class="event-type">${t}</span><span class="event-desc">${eventDesc(t)}</span></div>`).join('')}
    </div>
  </div>

  <div class="section">
    <h2>API Reference</h2>
    <table class="api-table">
      <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><span class="method get">GET</span></td><td class="mono">/notifications/events</td><td>List event types (public)</td></tr>
        <tr><td><span class="method get">GET</span></td><td class="mono">/notifications/prefs</td><td>List all preferences (auth)</td></tr>
        <tr><td><span class="method get">GET</span></td><td class="mono">/notifications/prefs/:keyId</td><td>Get preferences for a key (auth)</td></tr>
        <tr><td><span class="method put">PUT</span></td><td class="mono">/notifications/prefs/:keyId</td><td>Set preferences for a key (auth)</td></tr>
        <tr><td><span class="method del">DEL</span></td><td class="mono">/notifications/prefs/:keyId</td><td>Remove preferences (auth)</td></tr>
        <tr><td><span class="method get">GET</span></td><td class="mono">/notifications/history</td><td>Delivery history (auth, ?keyId=&limit=)</td></tr>
        <tr><td><span class="method post">POST</span></td><td class="mono">/notifications/test/:keyId</td><td>Send test notification (auth)</td></tr>
      </tbody>
    </table>
  </div>

</div>
</body>
</html>`);
    },
  );
}

function eventDesc(type: string): string {
  const map: Record<string, string> = {
    'scan.failed':           'Fired when a scan request fails across all providers.',
    'weekly.summary':        'Sent every Sunday at 09:00 UTC with a usage digest.',
    'provider.available':    'Fired when a circuit-broken provider comes back online.',
    'provider.unavailable':  'Fired when a provider circuit-breaker opens.',
    'subscription.changed':  "Fired when an API key's tier or permissions change.",
    'rate_limit.warning':    'Fired when an API key reaches 80% of its per-minute limit.',
  };
  return map[type] ?? type;
}
