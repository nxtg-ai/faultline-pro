// Validates: route audit 647bc10 rule 2 (emma-soul al:837ec6cea3437a7d, GoPMO 1.18.11.3)
//
// The route table, enumerated from Fastify's own onRoute hook:
//  - every route declares access, and public routes are exactly the allowlist;
//  - default-deny: every non-public route answers 401/403 with no key, before
//    schema validation can answer 400;
//  - cross-key: key A seeds data with a canary through every owner route that
//    creates something; key B calls every keyed GET and every id-taking route
//    with A's ids and must see neither the canary nor A's keyId, and change none
//    of A's objects;
//  - red controls: the sweep flags a deliberately unguarded data route, the
//    no-key check flags an open route, and a route with no declaration (or an
//    unlisted public one) cannot register.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildServer } from '../src/server.js';
import { PUBLIC_ROUTES } from '../src/lib/route-access.js';
import { requireAdmin, requireApiKey } from '../src/plugins/auth.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getTemplateStore, resetTemplateStore } from '../src/store/templates.js';
import { getScanQueue, resetScanQueue } from '../src/store/scan-queue.js';
import { getScanStore, resetScanStore } from '../src/store/scans.js';
import { resetComplianceHistoryStore } from '../src/store/compliance-history.js';
import { resetCostStore } from '../src/store/costs.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetRateLimitAlertStore } from '../src/store/rate-alerts.js';
import { resetApprovalStore } from '../src/store/approvals.js';
import { resetNotificationStore } from '../src/store/notifications.js';
import { resetJobStore } from '../src/store/jobs.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetCache } from '../src/store/cache.js';

const ADMIN = 'admin-secret';
const CANARY = 'CANARYA9q2';

beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

interface RouteRow { method: string; url: string; access: string | undefined; schema: RouteOptions['schema'] }

/** Every route of a built server, HEAD folded into GET (Fastify adds one per GET route). */
async function enumerate(app: FastifyInstance): Promise<RouteRow[]> {
  const rows = new Map<string, RouteRow>();
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      const method = m === 'HEAD' ? 'GET' : m;
      const key = `${method} ${route.url}`;
      if (!rows.has(key) || m !== 'HEAD') rows.set(key, { method, url: route.url, access: route.config?.access, schema: route.schema });
    }
  });
  await app.ready();
  return [...rows.values()].sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`));
}

const PUBLIC_SET = new Set(PUBLIC_ROUTES);
const isPublic = (r: RouteRow) => PUBLIC_SET.has(`${r.method} ${r.url}`);
const fill = (url: string, value: string) => url.replace(/:[A-Za-z]+/g, value).replace('*', value);
const hasParams = (url: string) => /:[A-Za-z]+/.test(url);

/** A body that satisfies a route's JSON schema, its strings carrying `marker`. */
function sample(schema: unknown, marker: string, field = ''): unknown {
  const s = (schema ?? {}) as Record<string, unknown>;
  if (Array.isArray(s.enum)) return s.enum.includes('mock') ? 'mock' : s.enum[0];
  if (s.default !== undefined) return s.default;
  switch (s.type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sample(v, marker, k)]));
    }
    case 'array': return Array.from({ length: Number(s.minItems ?? 1) }, () => sample(s.items, marker, field));
    case 'integer':
    case 'number': return Number(s.minimum ?? 1);
    case 'boolean': return false;
    case 'string': {
      if (s.format === 'uri' || /url/i.test(field)) return `https://example.com/${marker}`;
      if (s.format === 'email') return 'probe@example.com';
      if (field === 'cron') return '0 0 * * 0';
      if (field === 'provider') return 'mock';
      if (s.pattern) return `${marker.toLowerCase()}-probe`;
      const text = `${marker} the Eiffel Tower is in Paris.`;
      return text.slice(0, Number(s.maxLength ?? text.length));
    }
    default: return `${marker} probe`;
  }
}

function bodyFor(route: RouteRow, marker: string): object | undefined {
  if (route.method === 'GET' || route.method === 'DELETE') return undefined;
  const body = (route.schema as { body?: unknown } | undefined)?.body;
  return (body ? sample(body, marker) : { text: `${marker} the Eiffel Tower is in Paris.` }) as object;
}

function inject(app: FastifyInstance, key: string | null, method: string, url: string, payload?: object) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: { ...(key ? { 'x-api-key': key } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

/** Routes whose path parameter is not a stored per-key object (a catalogue name, a package). */
const NOT_OWNED_PARAM = new Set([
  'POST /scan/compliance/:template',
  'GET /npm/downloads/:package',
  'GET /npm/trend/:package',
]);

/** Seed bodies the schema sampler cannot build (handler-side validation, patterns). */
const SEED_BODIES: Record<string, object> = {
  'POST /scan': { text: `${CANARY} The Eiffel Tower is in Paris.`, provider: 'mock' },
  'POST /scan/compliance-gate': { text: `${CANARY} The Eiffel Tower is in Paris.`, provider: 'mock', projectName: CANARY },
  'POST /rules': { name: `${CANARY} rule`, description: CANARY, condition: 'contains_keyword', params: { keywords: [CANARY] }, severity: 'error' },
  'POST /orgs': { name: `${CANARY} org`, slug: 'canary-org-a' },
  'PUT /notifications/prefs/:keyId': { events: ['scan.complete'], webhookUrl: `https://example.com/${CANARY}` },
};

/** Owner routes that take ids in the body or need a multipart upload or an idempotency header. */
const SEED_SKIP = new Set(['POST /scan/compliance-diff', 'POST /scan/report/pdf', 'POST /scan/bulk', 'POST /scan/full']);

/** Owner routes A seeds through: each stores an object for the calling key. */
function seedRoutes(rows: RouteRow[]): RouteRow[] {
  const creators = rows.filter((r) => r.access === 'owner' && r.method !== 'GET' && r.method !== 'DELETE'
    && !hasParams(r.url) && !SEED_SKIP.has(`${r.method} ${r.url}`));
  return [...creators, ...rows.filter((r) => r.method === 'PUT' && r.url === '/notifications/prefs/:keyId')];
}

/** Body property names that carry a stored object's id. */
const ID_FIELD = /^(scanId|baselineScanId|currentScanId|scanIdA|scanIdB|templateId|jobId|id)$/;

function collectIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) { value.forEach((v) => collectIds(v, into)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && /^(id|jobId|scanId)$/.test(k)) into.add(v);
      else collectIds(v, into);
    }
  }
}

interface Violation { route: string; reason: string }

async function seed(app: FastifyInstance, rows: RouteRow[], a: { id: string; key: string }, ids: Set<string>): Promise<string[]> {
  const seeded: string[] = [];
  for (const r of seedRoutes(rows)) {
    const name = `${r.method} ${r.url}`;
    const res = await inject(app, a.key, r.method, fill(r.url, a.id), SEED_BODIES[name] ?? bodyFor(r, CANARY));
    if (res.statusCode >= 300) continue;
    seeded.push(name);
    try { collectIds(JSON.parse(res.body), ids); } catch { /* non-JSON */ }
  }
  return seeded;
}

/** B's calls for one route: the route with A's ids in its path, its id-carrying body fields, or its keyId filter. */
function probesFor(r: RouteRow, a: { id: string }, ids: string[]): Array<{ url: string; body?: object; mutation: boolean }> {
  const mutation = r.method !== 'GET';
  if (hasParams(r.url)) {
    const values = /:keyId/.test(r.url) ? [a.id] : ids;
    return values.map((id) => ({ url: fill(r.url, id), body: bodyFor(r, 'BPROBE'), mutation }));
  }
  if (r.method === 'GET') {
    const query = (r.schema as { querystring?: { properties?: Record<string, unknown> } } | undefined)?.querystring?.properties ?? {};
    return [r.url, ...('keyId' in query ? [`${r.url}?keyId=${a.id}`] : []), ...('projectName' in query ? [`${r.url}?projectName=${CANARY}`] : [])]
      .map((url) => ({ url, mutation: false }));
  }
  const body = bodyFor(r, 'BPROBE') as Record<string, unknown> | undefined;
  const idFields = Object.keys(body ?? {}).filter((k) => ID_FIELD.test(k));
  if (!body || idFields.length === 0) return [];
  return ids.map((id) => ({ url: r.url, body: { ...body, ...Object.fromEntries(idFields.map((k) => [k, id])) }, mutation: true }));
}

/**
 * Key A seeds through every owner creator; key B then reads every keyed GET and
 * calls every id-taking route with A's ids. Returns what B saw or changed.
 */
async function crossKeySweep(app: FastifyInstance, rows: RouteRow[], a: { id: string; key: string }, b: { id: string; key: string }, extraIds: string[] = []) {
  const ids = new Set<string>(extraIds);
  const seeded = await seed(app, rows, a, ids);
  const violations: Violation[] = [];
  const leaks = (body: string) => body.includes(CANARY) || body.includes(a.id);
  for (const r of rows.filter((row) => row.access === 'owner' || row.access === 'key')) {
    const name = `${r.method} ${r.url}`;
    for (const probe of probesFor(r, a, [...ids])) {
      const res = await inject(app, b.key, r.method, probe.url, probe.body);
      if (res.statusCode < 300 && leaks(res.body)) violations.push({ route: name, reason: `${probe.url}: returned A's data` });
      else if (probe.mutation && res.statusCode < 300 && !NOT_OWNED_PARAM.has(name) && (hasParams(r.url) || probe.body)) {
        violations.push({ route: name, reason: `${probe.url}: ${res.statusCode} on A's object` });
      }
    }
  }
  return { violations, seeded, ids: [...ids] };
}


/** Leaf path -> value of a JSON body; a non-JSON body is one leaf. */
function flatten(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { out.set('$body', body); return out; }
  const walk = (v: unknown, path: string): void => {
    if (v && typeof v === 'object') {
      const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
      out.set(`${path}#size`, String(entries.length));
      for (const [k, x] of entries) walk(x, `${path}.${k}`);
    } else out.set(path, JSON.stringify(v));
  };
  walk(parsed, '$');
  return out;
}

const changed = (x: Map<string, string>, y: Map<string, string>): Set<string> =>
  new Set([...new Set([...x.keys(), ...y.keys()])].filter((k) => x.get(k) !== y.get(k)));

/**
 * Differential arm (emma-soul seat on 914d85d): B reads every parameterless keyed
 * GET twice (the control round marks fields that move on their own, such as clocks
 * and B's own counters), A then scans and seeds, and B reads again. Any other field
 * that moved was moved by A: an aggregate that counts another key's activity.
 */
async function differentialSweep(app: FastifyInstance, rows: RouteRow[], a: { id: string; key: string }, b: { id: string; key: string }) {
  const reads = rows.filter((r) => (r.access === 'owner' || r.access === 'key') && r.method === 'GET' && !hasParams(r.url));
  const round = async () => {
    const snap = new Map<string, Map<string, string>>();
    for (const r of reads) {
      const res = await inject(app, b.key, 'GET', r.url);
      if (res.statusCode < 300) snap.set(r.url, flatten(res.body));
    }
    return snap;
  };
  const r1 = await round();
  const r2 = await round();
  for (let i = 0; i < 3; i++) {
    await inject(app, a.key, 'POST', '/scan', { text: `${CANARY} differential scan ${i}: the Eiffel Tower is in Paris.`, provider: 'mock' });
  }
  await seed(app, rows, a, new Set());
  const r3 = await round();
  const violations: Violation[] = [];
  for (const [url, after] of r3) {
    const before = r2.get(url);
    const first = r1.get(url);
    if (!before || !first) continue;
    const noisy = changed(first, before);
    const moved = [...changed(before, after)].filter((k) => !noisy.has(k));
    if (moved.length > 0) violations.push({ route: `GET ${url}`, reason: `moved after A acted: ${moved.slice(0, 5).join(', ')}` });
  }
  return { violations, read: reads.length, compared: r3.size };
}

/** Non-public routes that answer something other than 401/403 with no key. */
async function noKeyViolations(app: FastifyInstance, rows: RouteRow[]): Promise<string[]> {
  const open: string[] = [];
  for (const r of rows.filter((row) => !isPublic(row))) {
    const res = await inject(app, null, r.method, fill(r.url, 'probe-id'));
    if (res.statusCode !== 401 && res.statusCode !== 403) open.push(`${r.method} ${r.url} -> ${res.statusCode}`);
  }
  return open;
}

function resetStores(): void {
  resetKeyStore(); resetTemplateStore(); resetScanQueue(); resetScanStore(); resetComplianceHistoryStore();
  resetCostStore(); resetRateLimiter(); resetRateLimitAlertStore(); resetApprovalStore(); resetNotificationStore();
  resetJobStore(); resetUsageMeter(); resetAuditLogger(); resetCache();
}

describe('route table: declarations and default-deny', () => {
  let app: FastifyInstance;
  let rows: RouteRow[];

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    resetStores();
    app = buildServer();
    rows = await enumerate(app);
  });
  afterEach(async () => { await app.close(); delete process.env.FAULTLINE_API_KEY; });

  it('enumerates every route (199 app and plugin routes plus the CORS preflight), each with a declared access', () => {
    expect(rows.length).toBeGreaterThanOrEqual(200);
    const undeclared = rows.filter((r) => !['public', 'admin', 'owner', 'key'].includes(r.access ?? ''));
    expect(undeclared).toEqual([]);
  });

  it('public routes are exactly the allowlist, and every allowlist entry is a real route', () => {
    const publicRows = rows.filter((r) => r.access === 'public').map((r) => `${r.method} ${r.url}`).sort();
    expect(publicRows).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('default-deny: every non-public route answers 401 or 403 with no key (not 400, not data)', async () => {
    const guarded = rows.filter((r) => !isPublic(r));
    expect(guarded.length).toBeGreaterThan(160);
    expect(await noKeyViolations(app, rows)).toEqual([]);
  });

  it('a no-key request with a malformed body gets 401, not a schema 400', async () => {
    const res = await inject(app, null, 'POST', '/templates', { name: 42, unexpected: true });
    expect(res.statusCode).toBe(401);
  });
});

describe('route table: GraphQL (FAULTLINE_GRAPHQL=on) is keyed', () => {
  afterEach(() => { delete process.env.FAULTLINE_GRAPHQL; delete process.env.FAULTLINE_API_KEY; });

  it('GET and POST /graphql declare key access and refuse a no-key request', async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    process.env.FAULTLINE_GRAPHQL = 'on';
    resetStores();
    const app = buildServer();
    const rows = await enumerate(app);
    const gql = rows.filter((r) => r.url === '/graphql');
    expect(gql.map((r) => `${r.method}:${r.access}`).sort()).toEqual(['GET:key', 'POST:key']);
    expect(await noKeyViolations(app, rows)).toEqual([]);
    await app.close();
  });
});

describe('route table: cross-key sweep', () => {
  let app: FastifyInstance;
  let rows: RouteRow[];
  let keyA: { id: string; key: string };
  let keyB: { id: string; key: string };

  async function boot(extra?: (f: FastifyInstance) => void): Promise<void> {
    app = buildServer();
    if (extra) app.register(async (f) => extra(f));
    rows = await enumerate(app);
    getScanQueue().stop();
  }

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    resetStores();
    keyA = getKeyStore().create('tenant-a', ['scan', 'report', 'upload', 'pro']);
    keyB = getKeyStore().create('tenant-b', ['scan', 'report', 'upload', 'pro']);
  });
  afterEach(async () => { await app.close(); delete process.env.FAULTLINE_API_KEY; });

  it('key B sees none of key A\'s data and changes none of A\'s objects', async () => {
    await boot();
    // A pending queue item and a stored scan, so id-taking routes have live targets.
    const queued = getScanQueue().enqueue(keyA.id, 2, `${CANARY} queued`, 'mock');
    const scanned = getScanStore().record(keyA.id, `${CANARY} stored scan`, { claims: [{ text: CANARY }] });
    const { violations, seeded, ids } = await crossKeySweep(app, rows, keyA, keyB, [queued.id, scanned.id]);
    // Seeding reached the core owner creators, so the sweep had A's objects to aim at.
    for (const route of ['POST /templates', 'POST /queue/scans', 'POST /scan', 'POST /scan/compliance-gate', 'POST /schedules', 'POST /rules']) {
      expect(seeded).toContain(route);
    }
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(violations).toEqual([]);
    // A's objects survived B's sweep.
    expect(getScanQueue().get(queued.id)?.status).toBe('pending');
    expect(getTemplateStore().list().filter((t) => t.keyId === keyA.id).length).toBeGreaterThan(0);
  });

  it('differential: no keyed GET moves for key B when key A acts (aggregate leaks)', async () => {
    await boot();
    const { violations, read, compared } = await differentialSweep(app, rows, keyA, keyB);
    expect(read).toBeGreaterThanOrEqual(30);
    expect(compared).toBeGreaterThanOrEqual(25);
    expect(violations).toEqual([]);
  });

  it('red control: the differential arm flags a route that counts every key', async () => {
    await boot((f) => {
      f.get('/zz-fleet-count', { config: { access: 'key' } }, async () => ({ templates: getTemplateStore().list().length }));
    });
    const { violations } = await differentialSweep(app, rows, keyA, keyB);
    expect(violations.map((v) => v.route)).toContain('GET /zz-fleet-count');
  });

  it('red control: the sweep flags a deliberately unguarded data route', async () => {
    await boot((f) => {
      f.get('/zz-leaky-templates', { config: { access: 'owner' } }, async () => getTemplateStore().list());
      f.delete('/zz-leaky-templates/:id', { config: { access: 'owner' } }, async (request, reply) => {
        getTemplateStore().delete((request.params as { id: string }).id);
        return reply.status(204).send();
      });
    });
    const { violations } = await crossKeySweep(app, rows, keyA, keyB);
    const flagged = new Set(violations.map((v) => v.route));
    expect(flagged).toEqual(new Set(['GET /zz-leaky-templates', 'DELETE /zz-leaky-templates/:id']));
  });
});

describe('route table: red controls for the no-key check and registration', () => {
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('the no-key check flags an open data route (a server without the access hook)', async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    const bare = Fastify();
    bare.register(async (f) => { f.get('/zz-open', async () => ({ secret: CANARY })); });
    const rows = await enumerate(bare);
    expect(await noKeyViolations(bare, rows)).toEqual(['GET /zz-open -> 200']);
    await bare.close();
  });

  async function registerOn(route: (f: FastifyInstance) => void): Promise<unknown> {
    process.env.FAULTLINE_API_KEY = ADMIN;
    const app = buildServer();
    app.register(async (f) => route(f));
    try {
      await app.ready();
      return null;
    } catch (err) {
      return err;
    } finally {
      await app.close().catch(() => undefined);
    }
  }

  it('a route with no access declaration throws at registration', async () => {
    const err = await registerOn((f) => { f.get('/zz-undeclared', async () => ({ ok: true })); });
    expect(String(err)).toContain('GET /zz-undeclared declares no access');
  });

  it('a public route not on the allowlist throws at registration', async () => {
    const err = await registerOn((f) => { f.get('/zz-public', { config: { access: 'public' } }, async () => ({ ok: true })); });
    expect(String(err)).toContain('declares public access but is not on PUBLIC_ROUTES');
  });

  it('a declaration that contradicts the route\'s own key check throws', async () => {
    const asKey = await registerOn((f) => { f.get('/zz-a', { config: { access: 'key' }, preHandler: requireAdmin }, async () => ({})); });
    expect(String(asKey)).toContain('declares key access but requires the admin key');
    const asAdmin = await registerOn((f) => { f.get('/zz-b', { config: { access: 'admin' }, preHandler: requireApiKey }, async () => ({})); });
    expect(String(asAdmin)).toContain('declares admin access but checks only for a key');
  });

  it('a declared route with no preHandler still gets its access\'s key check', async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    const app = buildServer();
    app.register(async (f) => {
      f.get('/zz-owner', { config: { access: 'owner' } }, async () => ({ secret: CANARY }));
      f.get('/zz-admin', { config: { access: 'admin' } }, async () => ({ secret: CANARY }));
    });
    await app.ready();
    expect((await inject(app, null, 'GET', '/zz-owner')).statusCode).toBe(401);
    expect((await inject(app, null, 'GET', '/zz-admin')).statusCode).toBe(403);
    const plain = getKeyStore().create('plain', ['scan']);
    expect((await inject(app, plain.key, 'GET', '/zz-admin')).statusCode).toBe(403);
    expect((await inject(app, ADMIN, 'GET', '/zz-admin')).statusCode).toBe(200);
    await app.close();
  });
});
