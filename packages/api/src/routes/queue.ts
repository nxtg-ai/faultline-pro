import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getScanQueue, tierToPriority } from '../store/scan-queue.js';
import { getKeyStore } from '../store/keys.js';
import type { QueuePriority } from '../store/scan-queue.js';

type ScanProvider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

const ENQUEUE_BODY_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text:     { type: 'string', minLength: 1, maxLength: 50000 },
    provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
  },
  additionalProperties: false,
} as const;

interface EnqueueBody {
  text: string;
  provider?: ScanProvider;
}

function resolvePriority(keyId: string): QueuePriority {
  if (keyId === 'admin') return 0;
  const key = getKeyStore().validateById(keyId);
  if (!key) return 2;
  if (key.permissions.includes('admin')) return 0;
  if (key.permissions.includes('pro'))   return 1;
  return 2;
}

export async function queueRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /queue/scans — enqueue a scan
  fastify.post<{ Body: EnqueueBody }>(
    '/queue/scans',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Jobs'],
        summary: 'Enqueue a scan for async processing',
        description: 'Adds a scan to the priority queue. Pro/admin keys are processed before free-tier keys.',
        body: ENQUEUE_BODY_SCHEMA,
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const keyId = request.keyId ?? 'unknown';
      const { text, provider = 'gemini' } = request.body;
      const priority = resolvePriority(keyId);

      let item;
      try {
        item = getScanQueue().enqueue(keyId, priority, text, provider);
      } catch (err) {
        return reply.status(503).send({ error: err instanceof Error ? err.message : String(err) });
      }

      const position = getScanQueue().getPosition(item.id);
      return reply.status(202).send({
        id:        item.id,
        status:    item.status,
        priority:  item.priority,
        position,
        createdAt: item.createdAt,
        pollUrl:   `/queue/scans/${item.id}`,
      });
    },
  );

  // GET /queue/scans/:id — get item status + result
  fastify.get<{ Params: { id: string } }>(
    '/queue/scans/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Jobs'],
        summary: 'Get scan queue item status and result',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const item = getScanQueue().get(request.params.id);
      if (!item) return reply.status(404).send({ error: 'Queue item not found.' });

      const position = item.status === 'pending' ? getScanQueue().getPosition(item.id) : null;
      return reply.send({ ...item, position });
    },
  );

  // GET /queue/scans — list items for the authenticated key
  fastify.get<{ Querystring: { limit?: string } }>(
    '/queue/scans',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Jobs'],
        summary: 'List scan queue items for the authenticated key',
        querystring: {
          type: 'object',
          properties: { limit: { type: 'string' } },
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const keyId = request.keyId ?? 'unknown';
      const limit = Math.min(100, Number(request.query.limit ?? 20));
      const items = getScanQueue().list(keyId, limit);
      return reply.send({ total: items.length, items });
    },
  );

  // DELETE /queue/scans/:id — cancel a pending item
  fastify.delete<{ Params: { id: string } }>(
    '/queue/scans/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Jobs'],
        summary: 'Cancel a pending scan queue item',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const item = getScanQueue().get(request.params.id);
      if (!item) return reply.status(404).send({ error: 'Queue item not found.' });
      if (item.status !== 'pending') {
        return reply.status(409).send({ error: `Cannot cancel item with status '${item.status}'.` });
      }
      getScanQueue().cancel(request.params.id);
      return reply.status(204).send();
    },
  );

  // GET /queue/status — aggregate stats + configuration
  fastify.get(
    '/queue/status',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Scan queue aggregate status (public)',
        security: [],
      },
    },
    async (_request, reply) => {
      const stats = getScanQueue().getStats();
      const concurrency = Math.max(1, Number(process.env.FAULTLINE_QUEUE_CONCURRENCY ?? 3));
      return reply.send({
        ...stats,
        maxConcurrency: concurrency,
        priorityLevels: [
          { priority: 0, tier: 'admin',   description: 'Highest priority — processed first' },
          { priority: 1, tier: 'pro',     description: 'High priority' },
          { priority: 2, tier: 'free',    description: 'Normal priority' },
        ],
      });
    },
  );

  // GET /queue — HTML dashboard
  fastify.get(
    '/queue',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Scan queue dashboard (HTML, public)',
        security: [],
      },
    },
    async (_request, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(buildQueueHtml());
    },
  );
}

// ── HTML dashboard ─────────────────────────────────────────────────────────────

function buildQueueHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scan Queue — Faultline Pro</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
  header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;gap:12px}
  header h1{font-size:1.1rem;font-weight:600;color:#58a6ff}
  .container{max-width:960px;margin:0 auto;padding:24px}
  .stat-row{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:24px}
  .stat-card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
  .stat-card .label{font-size:.72rem;color:#7d8590;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
  .stat-card .value{font-size:1.6rem;font-weight:700}
  .pending{color:#d29922}.processing{color:#58a6ff}.completed{color:#3fb950}.failed{color:#f85149}.cancelled{color:#7d8590}
  .section{margin-bottom:28px}
  h2{font-size:.85rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;font-size:.83rem}
  th{text-align:left;padding:8px 10px;background:#161b22;color:#7d8590;border-bottom:1px solid #30363d;font-weight:500;font-size:.72rem;text-transform:uppercase}
  td{padding:8px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
  .badge{display:inline-block;padding:1px 7px;border-radius:3px;font-size:.7rem;font-weight:600}
  .bp{background:#2d2010;color:#d29922;border:1px solid #d29922}
  .bc{background:#1a2a3d;color:#58a6ff;border:1px solid #58a6ff}
  .bk{background:#122023;color:#3fb950;border:1px solid #3fb950}
  .bf{background:#3d1a1a;color:#f85149;border:1px solid #f85149}
  .bx{background:#21262d;color:#7d8590;border:1px solid #7d8590}
  .mono{font-family:'Fira Code','Courier New',monospace;font-size:.76rem;color:#7d8590}
  .p0{color:#d2a8ff}.p1{color:#79c0ff}.p2{color:#7d8590}
  .refresh-bar{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 14px;font-size:.78rem;color:#7d8590;display:flex;align-items:center;gap:8px;margin-bottom:20px}
  .dot{width:6px;height:6px;border-radius:50%;background:#3fb950;flex-shrink:0;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #countdown{font-weight:600;color:#58a6ff}
  .empty{color:#7d8590;font-style:italic;text-align:center;padding:16px}
</style>
</head>
<body>
<header>
  <div style="font-size:1.2rem;font-weight:700;letter-spacing:-.02em"><span style="color:#f85149">fault</span>line pro</div>
  <h1>Scan Queue</h1>
</header>
<div class="container">

  <div class="refresh-bar">
    <div class="dot"></div>
    Auto-refreshes in <span id="countdown">10</span>s &nbsp;·&nbsp; Priority: admin > pro > free &nbsp;·&nbsp; Max concurrency: <span id="concurrency">—</span>
  </div>

  <div class="stat-row">
    <div class="stat-card"><div class="label">Pending</div><div class="value pending" id="s-pending">—</div></div>
    <div class="stat-card"><div class="label">Processing</div><div class="value processing" id="s-processing">—</div></div>
    <div class="stat-card"><div class="label">Completed</div><div class="value completed" id="s-completed">—</div></div>
    <div class="stat-card"><div class="label">Failed</div><div class="value failed" id="s-failed">—</div></div>
    <div class="stat-card"><div class="label">Total</div><div class="value" style="color:#e6edf3" id="s-total">—</div></div>
  </div>

  <div class="section">
    <h2>Priority Levels</h2>
    <table>
      <thead><tr><th>Priority</th><th>Tier</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><span class="p0">0 — Highest</span></td><td class="p0">admin</td><td>Processed before all other requests</td></tr>
        <tr><td><span class="p1">1 — High</span></td><td class="p1">pro</td><td>Processed before free-tier requests</td></tr>
        <tr><td><span class="p2">2 — Normal</span></td><td class="p2">free</td><td>FIFO within priority level</td></tr>
      </tbody>
    </table>
  </div>

  <div class="section">
    <h2>API</h2>
    <table>
      <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
      <tbody>
        <tr><td><span class="badge bc">POST</span></td><td class="mono">/queue/scans</td><td>Enqueue a scan (auth) → 202 with id + pollUrl</td></tr>
        <tr><td><span class="badge bp">GET</span></td><td class="mono">/queue/scans/:id</td><td>Poll status + result (auth)</td></tr>
        <tr><td><span class="badge bp">GET</span></td><td class="mono">/queue/scans</td><td>List your items (auth, ?limit=)</td></tr>
        <tr><td><span class="badge bf">DEL</span></td><td class="mono">/queue/scans/:id</td><td>Cancel pending item (auth)</td></tr>
        <tr><td><span class="badge bp">GET</span></td><td class="mono">/queue/status</td><td>Aggregate counts (public)</td></tr>
      </tbody>
    </table>
  </div>

</div>
<script>
async function load() {
  try {
    const d = await fetch('/queue/status').then(r => r.json());
    document.getElementById('s-pending').textContent    = d.pending;
    document.getElementById('s-processing').textContent = d.processing;
    document.getElementById('s-completed').textContent  = d.completed;
    document.getElementById('s-failed').textContent     = d.failed;
    document.getElementById('s-total').textContent      = d.total;
    document.getElementById('concurrency').textContent  = d.maxConcurrency;
  } catch(e) { /* ignore */ }
}
let t = 10;
const cd = document.getElementById('countdown');
function tick() { t--; cd.textContent = t; if (t <= 0) { t = 10; load(); } }
load();
setInterval(tick, 1000);
</script>
</body>
</html>`;
}
