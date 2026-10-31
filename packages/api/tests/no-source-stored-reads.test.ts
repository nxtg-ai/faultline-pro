// Validates: no definite verdict without an openable source, on cached and stored scans
/**
 * A scan cached or stored before the no-source rule can hold a supported,
 * contradicted or mixed verdict with no source a reader can open. The stores
 * keep what was written; every read applies abstainScanWithoutSource, so such
 * a verdict is served as unverified with noSourceAbstain: true.
 *
 * Covered, each through every route that serves it:
 * - the scan cache: POST /scan and POST /scan/deep cache hits (X-Cache HIT),
 *   the cache-hit webhook payload, and the scan quota on a hit;
 * - the stored-scan store: GET /scan/report/pdf/:id, POST /scan/report/pdf
 *   with a scanId, GET /scan/:id/compliance, GET /scan/:id/compliance/badge
 *   and POST /scan/compliance-diff;
 * - the scan queue: GET /queue/scans/:id and GET /queue/scans;
 * - the full-scan job store: describeJob, the view GET /scan/full/:jobId sends,
 *   and the served count it bills on.
 * A static check at the end fails when a store file holds scan results or
 * verdicts and does not apply the guard on read.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NO_SOURCE_EXPLANATION, isBillableVerdict } from '@nxtg/faultline/lib/verdict-guard.js';
import type { VerificationResult } from '@nxtg/faultline/types.js';

const spies = vi.hoisted(() => ({
  webhooks: [] as Array<{ event: string; data: unknown }>,
  pdfInputs: [] as unknown[],
  complianceInputs: [] as unknown[],
  scanResult: null as Record<string, unknown> | null,
}));

vi.mock('../src/store/webhooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/store/webhooks.js')>();
  return {
    ...actual,
    fireWebhookEvent: vi.fn((event: string, data: unknown, owner: unknown) => {
      spies.webhooks.push({ event, data: JSON.parse(JSON.stringify(data)) });
      return (actual.fireWebhookEvent as (...a: unknown[]) => void)(event, data, owner);
    }),
  };
});

vi.mock('../src/store/pdf-report.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/store/pdf-report.js')>();
  return {
    ...actual,
    generatePdfReport: vi.fn(async (scan: Parameters<typeof actual.generatePdfReport>[0]) => {
      spies.pdfInputs.push(JSON.parse(JSON.stringify(scan)));
      return actual.generatePdfReport(scan);
    }),
  };
});

vi.mock('@nxtg/faultline/cli/compliance-report.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/cli/compliance-report.js')>();
  return {
    ...actual,
    buildEuComplianceReport: vi.fn((result: Parameters<typeof actual.buildEuComplianceReport>[0], opts: Parameters<typeof actual.buildEuComplianceReport>[1]) => {
      spies.complianceInputs.push(JSON.parse(JSON.stringify(result)));
      return actual.buildEuComplianceReport(result, opts);
    }),
  };
});

// The /scan miss returns the legacy-shaped result as given, as a scan cached
// before the rule would have been; the hit is what is under test.
vi.mock('@nxtg/faultline/cli/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/cli/scan.js')>();
  return {
    ...actual,
    scan: vi.fn(async () => structuredClone(spies.scanResult)),
  };
});

import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { getUsageMeter, resetUsageMeter } from '../src/store/usage.js';
import { resetCache, getScanCache } from '../src/store/cache.js';
import { getScanStore, resetScanStore } from '../src/store/scans.js';
import { getScanQueue, resetScanQueue } from '../src/store/scan-queue.js';
import { describeJob, type FullScanJob } from '../src/store/full-scan-jobs.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetCostStore } from '../src/store/costs.js';
import { resetGroundingAllowanceLedger } from '../src/store/grounding-allowance.js';

const DEFINITE = ['supported', 'contradicted', 'mixed'] as const;
/** The parts of a real engine result (mock provider) that a legacy result keeps as is. */
const realScanParts: { complianceReport?: unknown } = {};

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('@nxtg/faultline/cli/scan.js')>('@nxtg/faultline/cli/scan.js');
  const real = await actual.scan(TEXT, 'mock');
  expect(real.complianceReport).toBeDefined();
  realScanParts.complianceReport = real.complianceReport;
});
const TEXT = 'The Eiffel Tower was completed in 1889. Paris is in France. The Seine is a river.';
const PROVENANCE = {
  provider: 'openai', model: 'gpt-4o-mini', verifiedAt: '2026-10-01T00:00:00.000Z',
  retriever: 'openai-web-search', retrievedAt: '2026-10-01T00:00:00.000Z',
};

/** A scan result as stored before the rule: one claim per definite status, every one with sources []. */
function legacyResult(sources: Array<Record<string, unknown>> = []): Record<string, unknown> {
  const claims = DEFINITE.map((_, i) => ({ id: `c${i + 1}`, text: `Claim ${i + 1}.`, type: 'fact', importance: 3 }));
  const verifications = Object.fromEntries(DEFINITE.map((status, i) => [`c${i + 1}`, {
    claimId: `c${i + 1}`, status, explanation: 'model text', sources: structuredClone(sources), provenance: PROVENANCE,
  }]));
  return {
    input: TEXT, provider: 'openai', overallRisk: 'medium', claims, verifications,
    complianceReport: structuredClone(realScanParts.complianceReport), ruleFindings: [],
  };
}

function expectAllAbstained(verifications: unknown): void {
  const list = Object.values(verifications as Record<string, VerificationResult>);
  expect(list).toHaveLength(DEFINITE.length);
  for (const v of list) {
    expect(v.status).toBe('unverified');
    expect(v.noSourceAbstain).toBe(true);
    expect(v.explanation).toBe(NO_SOURCE_EXPLANATION);
    expect(v.sources).toEqual([]);
    expect(isBillableVerdict(v)).toBe(false);
  }
}

const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP', 'OPENAI_API_KEY', 'FAULTLINE_CONSENSUS'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let server: FastifyInstance;
let key: string;
let keyId: string;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.FAULTLINE_CONSENSUS;
  delete process.env.FAULTLINE_PROVIDER_SPEND_CAP;
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-no-source-reads-'));
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'spend.jsonl');
  process.env.OPENAI_API_KEY = 'test-openai';
  spies.webhooks.length = 0;
  spies.pdfInputs.length = 0;
  spies.complianceInputs.length = 0;
  spies.scanResult = legacyResult();
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  resetScanStore();
  resetScanQueue();
  resetCostStore();
  const created = getKeyStore().create('no-source-reads', ['pro', 'scan']);
  key = created.key;
  keyId = created.id;
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

const headers = () => ({ 'x-api-key': key, 'content-type': 'application/json' });

async function postScan(url: string): Promise<{ cache: unknown; body: Record<string, any> }> {
  const res = await server.inject({ method: 'POST', url, headers: headers(), payload: { text: TEXT, provider: 'openai' } });
  expect(res.statusCode, res.body).toBe(200);
  return { cache: res.headers['x-cache'], body: res.json() };
}

describe('scan cache: a legacy cached scan is served under the rule', () => {
  it('the store read guards and leaves the stored entry as written', () => {
    const caller = `${keyId}\u0000${keyId}`;
    expect(getScanCache().set(caller, TEXT, 'openai', legacyResult())).toBe(true);
    const hit = getScanCache().get(caller, TEXT, 'openai');
    expect(hit).not.toBeNull();
    expectAllAbstained(hit!.result.verifications);
    // A second read sees the raw entry again: the guard did not rewrite it.
    const again = getScanCache().get(caller, TEXT, 'openai');
    expectAllAbstained(again!.result.verifications);
    const raw = (getScanCache() as unknown as { store: Map<string, { result: Record<string, any> }> }).store;
    const entry = [...raw.values()][0];
    expect(entry.result.verifications.c1.status).toBe('supported');
  });

  it('POST /scan cache HIT and its webhook payload carry unverified with noSourceAbstain', async () => {
    const miss = await postScan('/scan');
    expect(miss.cache).toBe('MISS');
    expect(getScanCache().stats().size).toBe(1);
    spies.webhooks.length = 0;
    const hit = await postScan('/scan');
    expect(hit.cache).toBe('HIT');
    expect(hit.body.cache.hit).toBe(true);
    expectAllAbstained(hit.body.verifications);
    const complete = spies.webhooks.filter((w) => w.event === 'scan.complete');
    expect(complete).toHaveLength(1);
    expectAllAbstained((complete[0].data as { verifications: unknown }).verifications);
  });

  it('POST /scan cache HIT: the scan quota counts the cleaned verdicts, so an unopenable source bills nothing', async () => {
    // Raw, each verdict is billable by length: one source and an engine retriever.
    spies.scanResult = legacyResult([{ title: 'x', uri: 'javascript:alert(1)' }]);
    expect(isBillableVerdict((spies.scanResult.verifications as Record<string, unknown>).c1)).toBe(true);
    await postScan('/scan');
    const afterMiss = getUsageMeter().getMonthlyCount(keyId);
    const hit = await postScan('/scan');
    expect(hit.cache).toBe('HIT');
    expectAllAbstained(hit.body.verifications);
    expect(getUsageMeter().getMonthlyCount(keyId)).toBe(afterMiss);
  });

  it('POST /scan/deep cache HIT and its webhook payload carry unverified with noSourceAbstain', async () => {
    const caller = `${keyId}\u0000${keyId}`;
    expect(getScanCache().set(caller, TEXT, 'deep:openai', legacyResult())).toBe(true);
    const hit = await postScan('/scan/deep');
    expect(hit.cache).toBe('HIT');
    expect(hit.body.cache.hit).toBe(true);
    expectAllAbstained(hit.body.verifications);
    const complete = spies.webhooks.filter((w) => w.event === 'scan.complete');
    expect(complete).toHaveLength(1);
    expectAllAbstained((complete[0].data as { verifications: unknown }).verifications);
    expect(getUsageMeter().getMonthlyCount(keyId)).toBe(0);
  });
});

describe('stored-scan store: a legacy stored scan is read under the rule', () => {
  function storeLegacy(sources: Array<Record<string, unknown>> = []): string {
    return getScanStore().record(keyId, TEXT, legacyResult(sources)).id;
  }

  it('getById and list guard; the stored entry is not rewritten', () => {
    const id = storeLegacy();
    expectAllAbstained(getScanStore().getById(id)!.result.verifications);
    const listed = getScanStore().list(keyId);
    expect(listed).toHaveLength(1);
    expectAllAbstained(listed[0].result.verifications);
    const raw = (getScanStore() as unknown as { scans: Array<{ result: Record<string, any> }> }).scans;
    expect(raw[0].result.verifications.c1.status).toBe('supported');
  });

  it('GET /scan/report/pdf/:id renders the claims as unverified', async () => {
    const id = storeLegacy();
    const res = await server.inject({ method: 'GET', url: `/scan/report/pdf/${id}`, headers: { 'x-api-key': key } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.slice(0, 5).toString()).toBe('%PDF-');
    expect(spies.pdfInputs).toHaveLength(1);
    expectAllAbstained((spies.pdfInputs[0] as { verifications: unknown }).verifications);
  });

  it('POST /scan/report/pdf with a stored scanId renders the claims as unverified', async () => {
    const id = storeLegacy([{ title: 'x', uri: '/relative' }]);
    const res = await server.inject({ method: 'POST', url: '/scan/report/pdf', headers: headers(), payload: { scanId: id } });
    expect(res.statusCode).toBe(200);
    expect(spies.pdfInputs).toHaveLength(1);
    expectAllAbstained((spies.pdfInputs[0] as { verifications: unknown }).verifications);
  });

  it('GET /scan/:id/compliance and the badge build their report from unverified claims', async () => {
    const id = storeLegacy();
    const gate = await server.inject({ method: 'GET', url: `/scan/${id}/compliance`, headers: { 'x-api-key': key } });
    expect([200, 422]).toContain(gate.statusCode);
    const badge = await server.inject({ method: 'GET', url: `/scan/${id}/compliance/badge`, headers: { 'x-api-key': key } });
    expect(badge.statusCode).toBe(200);
    expect(spies.complianceInputs).toHaveLength(2);
    for (const input of spies.complianceInputs) expectAllAbstained((input as { verifications: unknown }).verifications);
  });

  it('POST /scan/compliance-diff compares unverified claims on both sides', async () => {
    const before = storeLegacy();
    const after = storeLegacy([{ title: 'x', uri: 'ftp://x' }]);
    const res = await server.inject({ method: 'POST', url: '/scan/compliance-diff', headers: headers(), payload: { beforeId: before, afterId: after } });
    expect(res.statusCode, res.body).toBe(200);
    expect(spies.complianceInputs).toHaveLength(2);
    for (const input of spies.complianceInputs) expectAllAbstained((input as { verifications: unknown }).verifications);
  });
});

describe('scan queue: a legacy queued result is read under the rule', () => {
  function queueLegacy(): string {
    const item = getScanQueue().enqueue(keyId, 1, TEXT, 'openai');
    // A completed item holding a result written before the rule.
    getScanQueue().cancel(item.id);
    item.status = 'completed';
    item.result = legacyResult();
    return item.id;
  }

  it('get and list guard; the stored item is not rewritten', () => {
    const id = queueLegacy();
    expectAllAbstained((getScanQueue().get(id)!.result as { verifications: unknown }).verifications);
    const listed = getScanQueue().list(keyId);
    expect(listed).toHaveLength(1);
    expectAllAbstained((listed[0].result as { verifications: unknown }).verifications);
    const raw = (getScanQueue() as unknown as { items: Map<string, { result: Record<string, any> }> }).items;
    expect(raw.get(id)!.result.verifications.c1.status).toBe('supported');
  });

  it('GET /queue/scans/:id and GET /queue/scans serve unverified with noSourceAbstain', async () => {
    const id = queueLegacy();
    const one = await server.inject({ method: 'GET', url: `/queue/scans/${id}`, headers: { 'x-api-key': key } });
    expect(one.statusCode).toBe(200);
    expectAllAbstained(one.json().result.verifications);
    const all = await server.inject({ method: 'GET', url: '/queue/scans', headers: { 'x-api-key': key } });
    expect(all.statusCode).toBe(200);
    expect(all.json().items).toHaveLength(1);
    expectAllAbstained(all.json().items[0].result.verifications);
  });
});

describe('full-scan job store: a legacy verdict is read under the rule', () => {
  function legacyJob(sources: Array<Record<string, unknown>>): FullScanJob {
    const result = legacyResult(sources);
    const verdicts = Object.values(result.verifications as Record<string, VerificationResult>);
    return {
      jobId: 'fsj_legacy', keyId, userRef: null, estimateId: 'e', idempotencyKey: 'idem-key-legacy',
      createdAt: 0, provider: 'openai', tier: 'pro', factClaims: verdicts.length, charged: 1,
      claims: [], text: '', factIds: ['c1', 'c2', 'c3'], verdicts, result,
      status: 'done', controller: new AbortController(), finishedAt: '2026-10-28T00:00:00.000Z',
    } as unknown as FullScanJob;
  }

  it('describeJob (GET /scan/full/:jobId) serves unverified verdicts and result, and bills none', () => {
    // Raw, each verdict is billable by length; the read guard runs before the served count.
    const job = legacyJob([{ title: 'x', uri: 'javascript:alert(1)' }]);
    expect(isBillableVerdict(job.verdicts[0])).toBe(true);
    const view = describeJob(job) as unknown as { progress: Array<{ status: string; verdict?: VerificationResult }>; units: { served: number }; result?: { verifications: unknown } };
    expect(view.progress).toHaveLength(3);
    expect(view.progress.map((p) => p.status)).toEqual(['unserved', 'unserved', 'unserved']);
    expectAllAbstained(Object.fromEntries(view.progress.map((p, i) => [i, p.verdict])));
    expect(view.units.served).toBe(0);
    expectAllAbstained(view.result!.verifications);
    // The job keeps what was recorded.
    expect(job.verdicts[0]!.status).toBe('supported');
  });
});

describe('every store that holds scan results or verdicts guards its reads', () => {
  const STORE_DIR = resolve(__dirname, '../src/store');
  /** Store files that hold no scan result and no per-claim verdict, with the reason. */
  const NOT_SCAN_RESULTS: Record<string, string> = {
    'pdf-report.ts': 'renders what a route passes in; holds nothing',
    'claims.ts': 'claim index: per-claim records built from already-guarded results; holds no verification objects',
    'compliance-templates.ts': 'reads statuses from a result passed in; holds none',
    'schedules.ts': 'keeps run results reduced to counts (overallRisk, claimCount); holds no verification objects',
    'webhooks.ts': 'sends what a route passes in; the only verifications held are a fixed test-event sample with sources',
  };
  /** A file holds scan results or verdicts when it names verifications/verdicts or a scan result field. */
  const HOLDS = /\bverifications\b|\bverdicts\s*[:=]|\bresult\??\s*:\s*(Record<string,\s*unknown>|unknown|ScanResult|FullScanResult)/;
  const GUARD = /\babstain(Scan)?WithoutSource\s*\(/;

  it('each such store file calls the read guard, or is listed with a reason', () => {
    const files = readdirSync(STORE_DIR).filter((f) => f.endsWith('.ts'));
    const holding = files.filter((f) => HOLDS.test(readFileSync(join(STORE_DIR, f), 'utf8')));
    expect(holding).toEqual(expect.arrayContaining(['cache.ts', 'scans.ts', 'scan-queue.ts', 'full-scan-jobs.ts']));
    const unguarded = holding.filter((f) => !(f in NOT_SCAN_RESULTS) && !GUARD.test(readFileSync(join(STORE_DIR, f), 'utf8')));
    expect(unguarded).toEqual([]);
  });

  /** Every definite verdict found anywhere inside `value` that has no openable source. */
  function sourcelessDefinite(value: unknown, seen = new Set<unknown>()): unknown[] {
    if (!value || typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);
    const v = value as { status?: unknown; sources?: unknown };
    const own = DEFINITE.includes(v.status as never)
      && !(Array.isArray(v.sources) && v.sources.some((s) => /^https?:\/\//.test(String((s as { uri?: unknown })?.uri ?? ''))))
      ? [value] : [];
    const inner = value instanceof Map ? [...value.values()] : Object.values(value);
    return [...own, ...inner.flatMap((x) => sourcelessDefinite(x, seen))];
  }

  /**
   * Call every read method of a store (every prototype method not named as a
   * write) with the arguments that reach the legacy entry, and check that no
   * return value holds a sourceless definite verdict. A new read method that
   * skips the guard fails here.
   */
  function readsOf(store: object, writes: string[], argSets: unknown[][]): Array<{ method: string; leaked: number }> {
    const proto = Object.getPrototypeOf(store) as Record<string, unknown>;
    const isMethod = (m: string) => typeof Object.getOwnPropertyDescriptor(proto, m)?.value === 'function';
    const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor' && isMethod(m) && !writes.includes(m));
    expect(methods.length).toBeGreaterThan(0);
    const out: Array<{ method: string; leaked: number }> = [];
    for (const m of methods) {
      for (const args of argSets) {
        let ret: unknown;
        try { ret = (proto[m] as (...a: unknown[]) => unknown).apply(store, args); } catch { continue; }
        out.push({ method: m, leaked: sourcelessDefinite(ret).length });
      }
    }
    return out;
  }

  it('no read method of the scan cache, stored-scan store or scan queue returns a sourceless definite verdict', () => {
    const caller = `${keyId}\u0000${keyId}`;
    getScanCache().set(caller, TEXT, 'openai', legacyResult());
    const stored = getScanStore().record(keyId, TEXT, legacyResult());
    const item = getScanQueue().enqueue(keyId, 1, TEXT, 'openai');
    getScanQueue().cancel(item.id);
    item.status = 'completed';
    item.result = legacyResult();

    const results = [
      ...readsOf(getScanCache(), ['set', 'flush', 'reset'], [[caller, TEXT, 'openai']]),
      ...readsOf(getScanStore(), ['record', 'reset'], [[stored.id], [keyId], []]),
      ...readsOf(getScanQueue(), ['enqueue', 'cancel', 'tick', 'start', 'stop', 'reset', 'dequeueNext', 'processItem', 'pruneCompleted'], [[item.id], [keyId], []]),
    ];
    expect(results.map((r) => r.method)).toEqual(expect.arrayContaining(['get', 'getById', 'list']));
    expect(results.filter((r) => r.leaked > 0)).toEqual([]);
  });

  it('the scan cache, stored-scan and queue read methods return through the guard', () => {
    const src = (f: string) => readFileSync(join(STORE_DIR, f), 'utf8');
    expect(src('cache.ts')).toMatch(/return \{ result: abstainScanWithoutSource\(entry\.result\)/);
    expect(src('scans.ts')).toMatch(/slice\(-limit\)\.map\(guarded\)/);
    expect(src('scans.ts')).toMatch(/: guarded\(entry\)/);
    expect(src('scan-queue.ts')).toMatch(/: guardedItem\(item\)/);
    expect(src('scan-queue.ts')).toMatch(/\.map\(guardedItem\)/);
  });
});
