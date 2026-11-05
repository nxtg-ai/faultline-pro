// Validates: claim meter and usage-record contract
//
// Every verifying route goes through the claim meter.
//
// The verifying routes are found by behaviour, not from a list:
//  1. Every route of a built server (enumerated through Fastify's onRoute hook)
//     is called with a metered customer key that has headroom, each with its own marker
//     in the text it submits. Background runners (scan queue, scheduled jobs)
//     are then driven. A route is VERIFYING when the provider verified a claim
//     carrying its marker.
//  2. Each verifying route is called again with a metered key whose cap is 0.
//     It must answer 402 claim_cap_reached, and no claim carrying its new marker
//     may reach the provider, even after the runners are driven.
//  3. Every route that sends a caller's text to a provider in any way (extract,
//     verify or critique), admin routes and GraphQL included, is either one of
//     the routes swept in step 2 or listed in NOT_METERED with a one-line
//     reason. A listed route that no longer reaches a provider fails too.
//  Red control: a route added to the test server that calls the engine without
//  the meter is found in step 1 and flagged in step 2.
//
//  The provider is a fixture answering as the engine's own 'gemini' instance
//  (helpers/engine-stand-in.ts), so its sourced verdicts are billable under
//  isBillableVerdict and every verifying route commits rows.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { ENGINE_PROVIDER, ONE_SOURCE, placeholderProviderKey } from './helpers/engine-stand-in.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { buildServer } from '../src/server.js';
import { requireApiKey } from '../src/plugins/auth.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getClaimMeter, resetClaimMeter } from '../src/store/claim-meter.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetCache } from '../src/store/cache.js';
import { getTemplateStore } from '../src/store/templates.js';
import { getScheduleStore, resetScheduleStore, resetScheduleRunner } from '../src/store/schedules.js';
import { getJobScheduler, getJobStore, resetJobStore, resetJobScheduler } from '../src/store/jobs.js';
import { getScanQueue, resetScanQueue } from '../src/store/scan-queue.js';
import { resetFullScanJobStore } from '../src/store/full-scan-jobs.js';
import { resetFullScanEstimateLimiter } from '../src/routes/full-scan.js';

// Upload text passes straight through, so an uploaded file's marker reaches the provider.
vi.mock('@nxtg/faultline/cli/extract.js', () => ({
  extractTextFromBuffer: async (buffer: Buffer) => buffer.toString('utf8'),
}));

/** Every claim text the provider was asked to verify. */
const verified: string[] = [];
/** Everything any provider call was given (extract, verify, critique), as JSON. */
const touched: string[] = [];

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const { engineStandInRegistry } = await import('./helpers/engine-stand-in.js');
  return engineStandInRegistry(await importOriginal(), () => ({
    name: 'Route-table fixture',
    modelId: 'fixture-v1',
    extractClaims: async (text: string): Promise<Claim[]> => {
      touched.push(JSON.stringify(text));
      return text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean)
        .map((s, i) => ({ id: `c${i + 1}`, text: s, type: 'fact' as const, importance: 5 }));
    },
    verifyClaim: async (claim: Claim): Promise<VerificationResult> => {
      verified.push(claim.text);
      touched.push(JSON.stringify(claim.text));
      return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: ONE_SOURCE };
    },
    generateCritiqueAndPrompt: async (...args: unknown[]) => {
      touched.push(JSON.stringify(args));
      return { critique: '', improvedPrompt: '' };
    },
  }));
});

/**
 * Routes that reach a provider and do not reserve through the claim meter, each
 * with the reason. Everything else that reaches a provider must be metered.
 */
const NOT_METERED: Readonly<Record<string, string>> = {
  'POST /scan/full/estimate': 'extracts claims to price a full scan and verifies none; POST /scan/full reserves the claims it prices',
  'POST /critique': 'critiques a prompt and verifies no claim, so there is no claim to bill; the burst limiter and fleet spend cap gate it',
  'POST /admin/verify-claims': 'admin only (server, admin and measurement keys), and those keys are never metered',
  'POST /graphql': 'its scan and scanBatch resolvers are admin only and GraphQL is off unless FAULTLINE_GRAPHQL=on; admin keys are never metered',
};

const RED_CONTROL = 'POST /test/unmetered-scan';
const ENV_KEYS = [
  'GEMINI_API_KEY', 'FAULTLINE_GRAPHQL', 'FAULTLINE_API_KEY', 'FAULTLINE_CLAIM_METER', 'FAULTLINE_CLAIM_METER_LEDGER', 'FAULTLINE_KEY_IDEMPOTENCY_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_FULL_JOBS_LEDGER', 'FAULTLINE_GROUNDING_LEDGER',
];
let saved: Record<string, string | undefined>;
let dir: string;

beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-claim-route-table-'));
  process.env.FAULTLINE_API_KEY = 'claim-route-table-server-key';
  process.env.FAULTLINE_CLAIM_METER = '1';
  process.env.GEMINI_API_KEY = placeholderProviderKey();
  process.env.FAULTLINE_GRAPHQL = 'on';
  process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER = join(dir, 'key-idempotency.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  process.env.FAULTLINE_FULL_JOBS_LEDGER = join(dir, 'full-scan-jobs.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding.jsonl');
  resetClaimMeter();
  resetKeyStore();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetClaimMeter();
  rmSync(dir, { recursive: true, force: true });
});

interface RouteRow { method: string; url: string; access: string | undefined; schema: RouteOptions['schema'] }
interface Key { id: string; key: string }

/** A server, the red-control route added when asked, and every route it registered. */
async function serverWithRoutes(withRedControl: boolean): Promise<{ app: FastifyInstance; rows: RouteRow[] }> {
  const app = buildServer();
  const rows = new Map<string, RouteRow>();
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      if (m === 'HEAD') continue;
      rows.set(`${m} ${route.url}`, { method: m, url: route.url, access: route.config?.access, schema: route.schema });
    }
  });
  if (withRedControl) {
    app.post<{ Body: { text: string } }>('/test/unmetered-scan', {
      config: { access: 'key' },
      preHandler: requireApiKey,
      schema: { body: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
    }, async (request) => scan(request.body.text, ENGINE_PROVIDER));
  }
  await app.ready();
  return { app, rows: [...rows.values()].sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`)) };
}

const fill = (url: string, value: string) => url.replace(/:[A-Za-z]+/g, value).replaceAll('*', value);

/** A value that satisfies a JSON schema, its free-text strings carrying `marker` as a sentence. */
function sample(schema: unknown, marker: string, field = ''): unknown {
  const s = (schema ?? {}) as Record<string, unknown>;
  if (Array.isArray(s.enum)) return s.enum.includes(ENGINE_PROVIDER) ? ENGINE_PROVIDER : s.enum[0];
  if (s.default !== undefined) return s.default;
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
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
      if (s.format === 'date-time') return '2099-01-01T00:00:00Z';
      if (field === 'cron') return '0 0 * * 0';
      if (field === 'provider') return ENGINE_PROVIDER;
      if (field === 'schedule') return 'hourly';
      if (s.pattern) return `${marker.toLowerCase()}-probe-1234`;
      const text = `${marker} says the Eiffel Tower is in Paris.`;
      return text.slice(0, Number(s.maxLength ?? text.length));
    }
    default: return `${marker} says the Eiffel Tower is in Paris.`;
  }
}

const BOUNDARY = 'ClaimMeterBoundary0001';

function multipart(parts: Array<{ name: string; value?: string; file?: { filename: string; mimetype: string; data: Buffer } }>): Buffer {
  const crlf = '\r\n';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if (p.file) {
      chunks.push(Buffer.from(`--${BOUNDARY}${crlf}Content-Disposition: form-data; name="${p.name}"; filename="${p.file.filename}"${crlf}Content-Type: ${p.file.mimetype}${crlf}${crlf}`));
      chunks.push(p.file.data, Buffer.from(crlf));
    } else {
      chunks.push(Buffer.from(`--${BOUNDARY}${crlf}Content-Disposition: form-data; name="${p.name}"${crlf}${crlf}${p.value}${crlf}`));
    }
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--${crlf}`));
  return Buffer.concat(chunks);
}

const sentence = (marker: string) => `${marker} says the Eiffel Tower is in Paris.`;

interface Probe { statusCode: number }

/** Call one route as `key`, its submitted text carrying `marker`. Routes that need set-up get it here. */
async function probe(app: FastifyInstance, r: RouteRow, key: Key, marker: string): Promise<Probe> {
  const name = `${r.method} ${r.url}`;
  const json = { 'x-api-key': key.key, 'content-type': 'application/json' };
  const send = async (method: string, url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method: method as 'POST', url, headers: { ...(payload ? json : { 'x-api-key': key.key }), ...headers }, ...(payload ? { payload } : {}) });

  switch (name) {
    case 'POST /scan/upload': {
      const body = multipart([{ name: 'provider', value: ENGINE_PROVIDER }, { name: 'file', file: { filename: 'probe.pdf', mimetype: 'application/pdf', data: Buffer.from(sentence(marker)) } }]);
      return app.inject({ method: 'POST', url: r.url, headers: { 'x-api-key': key.key, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, payload: body });
    }
    case 'POST /scan/bulk': {
      const zip = new AdmZip();
      zip.addFile('probe.txt', Buffer.from(sentence(marker)));
      const body = multipart([{ name: 'archive', file: { filename: 'probe.zip', mimetype: 'application/zip', data: zip.toBuffer() } }]);
      return app.inject({ method: 'POST', url: `${r.url}?provider=${ENGINE_PROVIDER}`, headers: { 'x-api-key': key.key, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, payload: body });
    }
    case 'POST /scan/full': {
      const est = await send('POST', '/scan/full/estimate', { text: sentence(marker), provider: ENGINE_PROVIDER });
      const estimateId = (est.json() as { estimateId?: string }).estimateId ?? 'none';
      return send('POST', r.url, { estimateId }, { 'idempotency-key': `idem-${marker.toLowerCase()}-0001` });
    }
    case 'POST /scan/template/:id': {
      const tpl = getTemplateStore().create(`tpl-${marker}`, { provider: ENGINE_PROVIDER }, key.id);
      return send('POST', fill(r.url, tpl.id), { text: sentence(marker), provider: ENGINE_PROVIDER });
    }
    case 'POST /schedules/:id/trigger': {
      const schedule = getScheduleStore().create({ name: `s-${marker}`, text: sentence(marker), provider: ENGINE_PROVIDER, cron: '0 0 * * 0' } as never, key.id);
      return send('POST', fill(r.url, schedule.id));
    }
    case 'POST /graphql':
      return send('POST', r.url, { query: `{ scan(text: ${JSON.stringify(sentence(marker))}, provider: "${ENGINE_PROVIDER}") { id } }` },
        { authorization: `Bearer ${key.key}` });
    case 'POST /critique': {
      // Critique calls the provider only for claims that did not pass.
      const claim = { id: 'c1', text: sentence(marker), type: 'fact', importance: 5 };
      const verifications = { c1: { claimId: 'c1', status: 'unverified', explanation: 'none', sources: [] } };
      return send('POST', r.url, { claims: [claim], verifications, text: sentence(marker), provider: ENGINE_PROVIDER });
    }
    case 'POST /scan/compliance/:template':
      return send('POST', fill(r.url, 'healthcare'), { text: sentence(marker), provider: ENGINE_PROVIDER });
    case 'POST /mcp': {
      // Hosted MCP: a real verify_claims tools/call. The route scans through POST
      // /scan in-process with this key, so the meter is POST /scan's. At the HTTP
      // layer it answers 200 and carries POST /scan's refusal as an MCP tool
      // error; the probe reports the refusal's status (402 claim_cap_reached).
      const res = await send('POST', r.url,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_claims', arguments: { text: sentence(marker), provider: ENGINE_PROVIDER } } },
        { accept: 'application/json, text/event-stream' });
      const result = (res.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }).result;
      const message = result?.content?.[0]?.text ?? '';
      if (res.statusCode === 200 && result?.isError && /\(402\)/.test(message) && /claim_cap_reached/.test(message)) return { statusCode: 402 };
      return { statusCode: res.statusCode };
    }
    default: break;
  }

  const schema = r.schema as { body?: unknown; querystring?: { properties?: Record<string, unknown> } } | undefined;
  const url = fill(r.url, `${marker.toLowerCase()}-id`);
  if (r.method === 'GET' || r.method === 'DELETE') {
    const props = schema?.querystring?.properties ?? {};
    const query = new URLSearchParams(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, String(sample(v, marker, k))])));
    return send(r.method, query.size > 0 ? `${url}?${query}` : url);
  }
  const body = (schema?.body ? sample(schema.body, marker) : { text: sentence(marker), provider: ENGINE_PROVIDER }) as object;
  return send(r.method, url, body);
}

/** Run what background runners would run later: the scan queue and every scheduled job. */
async function driveRunners(): Promise<void> {
  const queue = getScanQueue();
  for (let i = 0; i < 20 && queue.list().some((item) => item.status === 'pending' || item.status === 'processing'); i++) {
    queue.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (const job of getJobStore().list()) await getJobScheduler().triggerJob(job.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const markerFor = (phase: string, i: number) => `MK${phase}${i}Q`;
const reached = (marker: string) => verified.some((text) => text.includes(marker));
const reachedProvider = (marker: string) => touched.some((text) => text.includes(marker));

function resetState(): void {
  resetRateLimiter();
  resetCache();
  resetFullScanJobStore();
  resetFullScanEstimateLimiter();
  resetJobStore();
  resetJobScheduler();
  resetScanQueue();
  resetScheduleStore();
  resetScheduleRunner();
}

/** Step 1: which routes send a caller's text to the provider. */
async function findVerifyingRoutes(app: FastifyInstance, rows: RouteRow[], key: Key): Promise<RouteRow[]> {
  const candidates = rows.filter((r) => r.access === 'key' || r.access === 'owner');
  const markers = candidates.map((_, i) => markerFor('A', i));
  for (const [i, r] of candidates.entries()) await probe(app, r, key, markers[i]);
  await driveRunners();
  return candidates.filter((_, i) => reached(markers[i]));
}

/**
 * Step 3: every route that sends a caller's text to any provider call. Routes
 * open to customer keys are called with `customerKey`, admin routes and GraphQL
 * with the server key.
 */
async function findProviderRoutes(app: FastifyInstance, rows: RouteRow[], customerKey: Key, serverKey: Key): Promise<string[]> {
  const markers = rows.map((_, i) => markerFor('C', i));
  for (const [i, r] of rows.entries()) {
    // GraphQL takes any key at the door, but its scan resolvers are admin only.
    const customerRoute = (r.access === 'key' || r.access === 'owner') && r.url !== '/graphql';
    await probe(app, r, customerRoute ? customerKey : serverKey, markers[i]);
  }
  await driveRunners();
  return rows.filter((_, i) => reachedProvider(markers[i])).map((r) => `${r.method} ${r.url}`);
}

interface Violation { route: string; reason: string }

/** Step 2: each verifying route, called with a zero-cap key, answers 402 and verifies nothing. */
async function sweepZeroCap(app: FastifyInstance, verifying: RouteRow[], key: Key): Promise<Violation[]> {
  resetState();
  const violations: Violation[] = [];
  const markers = verifying.map((_, i) => markerFor('B', i));
  const statuses: number[] = [];
  for (const [i, r] of verifying.entries()) statuses.push((await probe(app, r, key, markers[i])).statusCode);
  await driveRunners();
  for (const [i, r] of verifying.entries()) {
    const route = `${r.method} ${r.url}`;
    if (reached(markers[i])) violations.push({ route, reason: 'a claim reached the provider with no headroom' });
    else if (statuses[i] !== 402) violations.push({ route, reason: `answered ${statuses[i]}, expected 402 claim_cap_reached` });
  }
  return violations;
}

describe('every verifying route is metered', () => {
  it('finds the verifying routes by behaviour, and each refuses a zero-cap key before any provider call', async () => {
    verified.length = 0;
    resetState();
    const { app, rows } = await serverWithRoutes(false);
    try {
      const roomy = getKeyStore().create('roomy', ['scan', 'pro'], undefined, { claimCap: 1_000_000, metered: true });
      const verifying = await findVerifyingRoutes(app, rows, roomy);
      const names = verifying.map((r) => `${r.method} ${r.url}`);
      // The sweep must actually reach the routes the meter is for (a broken sampler would pass vacuously).
      expect(names).toEqual(expect.arrayContaining([
        'POST /scan', 'GET /scan/stream', 'POST /scan/stream', 'POST /scan/deep', 'POST /scan/batch', 'POST /scan/upload',
        'POST /scan/template/:id', 'POST /scan/full', 'POST /scan/compliance-gate', 'POST /scan/diff',
        'POST /scan/compliance/:template', 'POST /scan/report', 'POST /scan/eu-report', 'POST /scan/bulk',
        'POST /jobs', 'POST /queue/scans', 'POST /schedules/:id/trigger', 'POST /mcp',
      ]));
      // The estimate extracts but never verifies.
      expect(names).not.toContain('POST /scan/full/estimate');
      // Every verifying route recorded its claims: none was dropped for an out-of-shape scanId or claimId.
      const totals = getClaimMeter().totals();
      expect(totals.used).toBeGreaterThan(0);
      expect(totals.refusedIdentifiers).toBe(0);
      const scans = new Set(getClaimMeter().page(0, 1000).records.map((r) => r.scanId));
      expect(scans.size).toBeGreaterThanOrEqual(verifying.length);

      const zero = getKeyStore().create('zero', ['scan', 'pro'], undefined, { claimCap: 0, metered: true });
      expect(await sweepZeroCap(app, verifying, zero)).toEqual([]);

      // Step 3: nothing else reaches a provider unless it is listed with a reason.
      resetState();
      const server = { id: 'admin', key: process.env.FAULTLINE_API_KEY as string };
      const roomy2 = getKeyStore().create('roomy-2', ['scan', 'pro'], undefined, { claimCap: 1_000_000, metered: true });
      const providerRoutes = await findProviderRoutes(app, rows.filter((r) => r.method !== 'DELETE'), roomy2, server);
      expect(providerRoutes).toEqual(expect.arrayContaining(names));
      const unaccounted = providerRoutes.filter((route) => !names.includes(route) && !(route in NOT_METERED));
      expect(unaccounted).toEqual([]);
      // Every exemption names a route that does reach a provider and is not metered.
      expect(Object.keys(NOT_METERED).filter((route) => !providerRoutes.includes(route))).toEqual([]);
      expect(Object.keys(NOT_METERED).filter((route) => names.includes(route))).toEqual([]);
      for (const reason of Object.values(NOT_METERED)) expect(reason.length).toBeGreaterThan(20);
    } finally {
      await app.close();
    }
  }, 90_000);

  it('red control: a route that calls the engine without the meter is flagged', async () => {
    verified.length = 0;
    resetState();
    const { app, rows } = await serverWithRoutes(true);
    try {
      const roomy = getKeyStore().create('roomy', ['scan', 'pro'], undefined, { claimCap: 1_000_000, metered: true });
      const verifying = await findVerifyingRoutes(app, rows.filter((r) => `${r.method} ${r.url}` === RED_CONTROL || r.url === '/scan'), roomy);
      expect(verifying.map((r) => `${r.method} ${r.url}`)).toContain(RED_CONTROL);
      const zero = getKeyStore().create('zero', ['scan', 'pro'], undefined, { claimCap: 0, metered: true });
      expect(await sweepZeroCap(app, verifying, zero)).toEqual([{ route: RED_CONTROL, reason: 'a claim reached the provider with no headroom' }]);
    } finally {
      await app.close();
    }
  });
});
