// Validates: every engine call the API makes lands in the provider-spend ledger.
/**
 * Every API engine call spends Faultline's own provider keys (there is no
 * bring-your-own-key path), so each one must write a provider-spend row, or the
 * fleet spend cap cannot see it.
 *
 * Two checks:
 * 1. Each engine-calling route or background runner, driven once, writes the
 *    expected number of spend rows.
 * 2. The source files are read for engine imports, and every file that calls the
 *    engine must be covered by a case below or sit in the allowlist with a reason.
 *    A new route that calls the engine without a case here fails this test.
 *
 * The stock mock provider prices at $0 and the ledger refuses $0 rows, so the
 * registry returns a fixture provider that reports real usage through the
 * production usage seam on every call. A text containing EXTRACT_FAILS reports
 * usage and then fails extraction, as a provider that answered with something
 * unusable would.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import AdmZip from 'adm-zip';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { recordUsage } from '@nxtg/faultline/lib/usage-sink.js';
import { ExtractionError } from '@nxtg/faultline/providers/extraction-error.js';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetCostStore } from '../src/store/costs.js';
import { resetFullScanJobStore } from '../src/store/full-scan-jobs.js';
import { resetFullScanEstimateLimiter } from '../src/routes/full-scan.js';
import { getScanQueue, resetScanQueue } from '../src/store/scan-queue.js';
import { getJobScheduler, resetJobStore, resetJobScheduler } from '../src/store/jobs.js';
import { resetScheduleStore, resetScheduleRunner } from '../src/store/schedules.js';
import { resetBulkJobStore } from '../src/store/bulk-jobs.js';
import { resetTemplateStore } from '../src/store/templates.js';

const EXTRACT_FAILS = 'EXTRACT_FAILS';

function billedLeg(): void {
  recordUsage({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 200, isGrounding: false });
}

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      name: 'Billing Fixture',
      modelId: 'gpt-4o-mini',
      extractClaims: async (text: string): Promise<Claim[]> => {
        billedLeg();
        if (text.includes(EXTRACT_FAILS)) throw new ExtractionError('invalid_output');
        return text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).map((s, i) => ({
          id: `c${i + 1}`, text: s, type: 'fact', importance: 3,
        }));
      },
      verifyClaim: async (claim: Claim): Promise<VerificationResult> => {
        billedLeg();
        if (claim.text.includes(EXTRACT_FAILS)) throw new Error('provider reply could not be read');
        return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: [] };
      },
      generateCritiqueAndPrompt: async (text: string) => {
        billedLeg();
        if (text.includes(EXTRACT_FAILS)) throw new Error('provider reply could not be read');
        return { critique: 'one claim was contradicted', improvedPrompt: 'cite sources' };
      },
    })),
  };
});

// /scan/upload reads PDFs and images; the text extraction is not what is under test.
vi.mock('@nxtg/faultline/cli/extract.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/cli/extract.js')>();
  return { ...actual, extractTextFromBuffer: vi.fn(async () => 'Paris is in France. The Moon orbits the Earth.') };
});

const SERVER_KEY = 'engine-spend-server-key';
const TEXT = 'Paris is in France. Water boils at 100 C at sea level. The Moon orbits the Earth.';
const TEXT_2 = 'Mount Everest is in Nepal. The Pacific is an ocean.';
const ENV_KEYS = ['FAULTLINE_MEASUREMENT_KEY', 'FAULTLINE_API_KEY', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP', 'FAULTLINE_FULL_JOBS_LEDGER', 'FAULTLINE_GRAPHQL'];

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let spendLedger: string;
let server: FastifyInstance;

/** The key every case sends. The server key unless a describe block below swaps it. */
let callerKey = SERVER_KEY;
let headers = { 'x-api-key': callerKey, 'content-type': 'application/json' };
function useKey(key: string): void {
  callerKey = key;
  headers = { 'x-api-key': key, 'content-type': 'application/json' };
}

function spendRows(): Array<Record<string, unknown>> {
  if (!existsSync(spendLedger)) return [];
  return readFileSync(spendLedger, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/** Wait for a background runner to write `count` rows. */
async function waitForRows(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (spendRows().length < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} spend rows, have ${spendRows().length}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function multipart(boundary: string, field: string, filename: string, mimetype: string, data: Buffer, fields: Record<string, string> = {}): Buffer {
  const crlf = '\r\n';
  return Buffer.concat([
    ...Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="${name}"${crlf}${crlf}${value}${crlf}`)),
    Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="${field}"; filename="${filename}"${crlf}Content-Type: ${mimetype}${crlf}${crlf}`),
    data,
    Buffer.from(`${crlf}--${boundary}--${crlf}`),
  ]);
}

interface SpendCase {
  name: string;
  /** Source files under packages/api/src this case drives, relative to src. */
  files: string[];
  /** Spend rows the case must write: one per engine call. */
  rows: number;
  run: () => Promise<void>;
}

const CASES: SpendCase[] = [
  {
    name: 'POST /scan', files: ['routes/scan.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan', headers, payload: { text: TEXT, provider: 'mock' } });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /scan with pipelineConfig', files: ['routes/scan.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan', headers, payload: { text: TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'mock', verificationProvider: 'mock' } } });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /scan/template/:id', files: ['routes/scan.ts'], rows: 1,
    run: async () => {
      const created = await server.inject({ method: 'POST', url: '/templates', headers, payload: { name: 'spend', provider: 'mock' } });
      expect(created.statusCode).toBe(201);
      const res = await server.inject({ method: 'POST', url: `/scan/template/${created.json().id}`, headers, payload: { text: TEXT } });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /scan/stream', files: ['routes/stream.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan/stream', headers, payload: { text: TEXT, provider: 'mock' } });
      expect(res.body).toContain('"type":"complete"');
    },
  },
  {
    name: 'GET /scan/stream', files: ['routes/stream.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'GET', url: `/scan/stream?provider=mock&text=${encodeURIComponent(TEXT)}`, headers: { 'x-api-key': callerKey } });
      expect(res.body).toContain('"type":"complete"');
    },
  },
  {
    name: 'POST /scan/deep', files: ['routes/deep.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan/deep', headers, payload: { text: TEXT, provider: 'mock' } });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /scan/diff (two scans)', files: ['routes/diff.ts'], rows: 2,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan/diff', headers, payload: { before: TEXT, after: TEXT_2, provider: 'mock' } });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /scan/batch (two texts)', files: ['routes/batch.ts'], rows: 2,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan/batch', headers, payload: { texts: [TEXT, TEXT_2], provider: 'mock' } });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /scan/report', files: ['routes/report.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan/report', headers, payload: { text: TEXT, provider: 'mock' } });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /scan/eu-report', files: ['routes/eu-report.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan/eu-report', headers, payload: { text: TEXT, provider: 'mock' } });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /scan/compliance/:template', files: ['routes/compliance.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan/compliance/healthcare', headers, payload: { text: TEXT, provider: 'mock' } });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /scan/compliance-gate', files: ['routes/compliance-gate.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan/compliance-gate', headers, payload: { text: TEXT, provider: 'mock' } });
      // The mock's verdicts carry no source, so they read unverified and the scan is high
      // risk: the gate fails (422) after the scan ran, and the spend row is still written.
      expect(res.statusCode).toBe(422);
    },
  },
  {
    name: 'POST /scan/upload', files: ['routes/upload.ts'], rows: 1,
    run: async () => {
      const boundary = 'SpendUploadBoundary';
      const res = await server.inject({
        method: 'POST', url: '/scan/upload',
        headers: { 'x-api-key': callerKey, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipart(boundary, 'file', 'doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4 fixture'), { provider: 'mock' }),
      });
      expect(res.statusCode, res.body).toBe(200);
    },
  },
  {
    name: 'POST /scan/bulk (two files, background)', files: ['routes/bulk.ts'], rows: 2,
    run: async () => {
      const zip = new AdmZip();
      zip.addFile('a.txt', Buffer.from(TEXT));
      zip.addFile('b.txt', Buffer.from(TEXT_2));
      const boundary = 'SpendBulkBoundary';
      const res = await server.inject({
        method: 'POST', url: '/scan/bulk?provider=mock',
        headers: { 'x-api-key': callerKey, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: multipart(boundary, 'archive', 'docs.zip', 'application/zip', zip.toBuffer()),
      });
      expect(res.statusCode).toBe(202);
      await waitForRows(2);
    },
  },
  {
    name: 'POST /queue/scans, then the queue runs it', files: ['store/scan-queue.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/queue/scans', headers, payload: { text: TEXT, provider: 'mock' } });
      expect(res.statusCode).toBe(202);
      getScanQueue().tick();
      await waitForRows(1);
    },
  },
  {
    name: 'POST /schedules/:id/trigger', files: ['store/schedules.ts'], rows: 1,
    run: async () => {
      const created = await server.inject({ method: 'POST', url: '/schedules', headers, payload: { name: 'spend', cron: '0 * * * *', text: TEXT, provider: 'mock' } });
      expect(created.statusCode).toBe(201);
      const res = await server.inject({ method: 'POST', url: `/schedules/${created.json().id}/trigger`, headers: { 'x-api-key': callerKey } });
      expect(res.statusCode).toBe(202);
      await waitForRows(1);
    },
  },
  {
    name: 'POST /jobs, then the job scheduler runs it', files: ['store/jobs.ts'], rows: 1,
    run: async () => {
      const created = await server.inject({ method: 'POST', url: '/jobs', headers, payload: { text: TEXT, provider: 'mock', schedule: '*/5 * * * *' } });
      expect(created.statusCode).toBe(201);
      await getJobScheduler().triggerJob(created.json().id);
    },
  },
  {
    name: 'GraphQL scan query', files: ['graphql/resolvers.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/graphql', headers, payload: { query: `query { scan(text: ${JSON.stringify(TEXT)}, provider: "mock") { id overallRisk } }` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().errors).toBeUndefined();
    },
  },
  {
    name: 'GraphQL scanBatch mutation (two texts)', files: ['graphql/resolvers.ts'], rows: 2,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/graphql', headers, payload: { query: `mutation { scanBatch(texts: [${JSON.stringify(TEXT)}, ${JSON.stringify(TEXT_2)}], provider: "mock") { id } }` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().errors).toBeUndefined();
    },
  },
  {
    name: 'POST /scan/full/estimate', files: ['routes/full-scan.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/scan/full/estimate', headers, payload: { text: TEXT, provider: 'mock' } });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /critique', files: ['routes/critique.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({
        method: 'POST', url: '/critique', headers,
        payload: {
          text: TEXT, provider: 'mock',
          claims: [{ id: 'c1', text: 'Paris is in France', type: 'fact', importance: 3 }],
          verifications: { c1: { claimId: 'c1', status: 'contradicted', explanation: 'no', sources: [] } },
        },
      });
      expect(res.statusCode).toBe(200);
    },
  },
  {
    name: 'POST /admin/verify-claims', files: ['routes/admin-verify.ts'], rows: 1,
    run: async () => {
      const res = await server.inject({ method: 'POST', url: '/admin/verify-claims', headers, payload: { claims: [{ id: 'c1', text: 'Paris is in France.' }], provider: 'mock' } });
      expect(res.statusCode).toBe(200);
    },
  },
];

/** Engine-calling files no case above drives, each with the reason. Empty today. */
const ALLOWLIST: Record<string, string> = {};

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Files that import an engine entry point as a value: scan, the full-scan
 * extract and verify steps, or a provider from the registry. A type-only import
 * does not count.
 */
function engineCallingFiles(): string[] {
  const engineImport = /^import\s+\{([^}]*)\}\s+from\s+'@nxtg\/faultline\/(cli\/scan|providers\/registry)\.js'/gm;
  const entryPoints = new Set(['scan', 'extractForFullScan', 'verifyFullScan', 'getProvider']);
  return sourceFiles(SRC_DIR).filter((path) => {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(engineImport)) {
      const names = match[1].split(',').map((n) => n.trim()).filter((n) => !n.startsWith('type '));
      if (names.some((n) => entryPoints.has(n.split(/\s+as\s+/)[0]))) return true;
    }
    return false;
  }).map((path) => relative(SRC_DIR, path).split('\\').join('/')).sort();
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-engine-spend-'));
  spendLedger = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = spendLedger;
  process.env.FAULTLINE_FULL_JOBS_LEDGER = join(tmpDir, 'full-scan-jobs.jsonl');
  process.env.FAULTLINE_GRAPHQL = 'on';
  delete process.env.FAULTLINE_PROVIDER_SPEND_CAP;
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  resetCircuitBreaker();
  resetCostStore();
  resetProviderSpendLedger();
  resetFullScanJobStore();
  resetFullScanEstimateLimiter();
  resetScanQueue();
  resetJobStore();
  resetJobScheduler();
  resetScheduleStore();
  resetScheduleRunner();
  resetBulkJobStore();
  resetTemplateStore();
  useKey(SERVER_KEY);
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetFullScanJobStore();
  resetScanQueue();
  resetJobScheduler();
  resetScheduleRunner();
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetProviderSpendLedger();
});

describe('every engine call writes a provider-spend row', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      await c.run();
      const rows = spendRows();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).toHaveLength(c.rows);
      for (const row of rows) expect(row.costUsd as number).toBeGreaterThan(0);
      // The server key (faultline-web's) is internal traffic on every path.
      for (const row of rows) expect(row.keyClass).toBe('internal');
    });
  }

  it('every engine-calling source file is driven by a case or allowlisted with a reason', () => {
    const engineFiles = engineCallingFiles();
    expect(engineFiles.length).toBeGreaterThan(0);
    const covered = new Set([...CASES.flatMap((c) => c.files), ...Object.keys(ALLOWLIST)]);
    expect(engineFiles.filter((f) => !covered.has(f))).toEqual([]);
    // A case or allowlist entry for a file that no longer calls the engine is stale.
    expect([...covered].filter((f) => !engineFiles.includes(f))).toEqual([]);
    for (const reason of Object.values(ALLOWLIST)) expect(reason.trim()).not.toBe('');
  });
});

// Validates: every spend row carries the key class of the key it was spent for.
describe('every engine path labels its spend row with the caller\'s key class', () => {
  /** Cases a non-admin key cannot reach: the route (or GraphQL scan resolver) is admin only. */
  const ADMIN_ONLY = new Set(['POST /admin/verify-claims', 'GraphQL scan query', 'GraphQL scanBatch mutation (two texts)']);

  for (const c of CASES.filter((x) => !ADMIN_ONLY.has(x.name))) {
    it(`${c.name}: a customer keystore key writes keyClass customer`, async () => {
      useKey(getKeyStore().create('customer', ['scan']).key);
      await c.run();
      const rows = spendRows();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).toHaveLength(c.rows);
      for (const row of rows) expect(row.keyClass).toBe('customer');
      // A class, never the key's id.
      for (const row of rows) expect(row).not.toHaveProperty('keyId');
    });
  }

  for (const name of ['POST /scan', 'POST /scan/stream', 'POST /critique', 'POST /admin/verify-claims', 'POST /scan/full/estimate']) {
    it(`${name}: a keystore key with the admin permission writes keyClass internal`, async () => {
      useKey(getKeyStore().create('ops', ['scan', 'admin']).key);
      await CASES.find((x) => x.name === name)!.run();
      const rows = spendRows();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.keyClass).toBe('internal');
    });
  }

  it('POST /admin/verify-claims: the measurement key writes keyClass measurement', async () => {
    process.env.FAULTLINE_MEASUREMENT_KEY = 'engine-spend-measurement-key';
    useKey('engine-spend-measurement-key');
    await CASES.find((x) => x.name === 'POST /admin/verify-claims')!.run();
    const rows = spendRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].keyClass).toBe('measurement');
  });

  it('a job with no recorded owner (the anonymous path) writes keyClass anonymous', async () => {
    const created = await server.inject({ method: 'POST', url: '/jobs', headers, payload: { text: TEXT, provider: 'mock', schedule: '*/5 * * * *' } });
    expect(created.statusCode).toBe(201);
    // Drop the owner the store recorded, as a job created before owners were kept has none.
    const { getJobStore } = await import('../src/store/jobs.js');
    vi.spyOn(getJobStore(), 'ownerOf').mockReturnValue(null);
    await getJobScheduler().triggerJob(created.json().id);
    const rows = spendRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].keyClass).toBe('anonymous');
  });

  it('POST /scan/full: a customer key labels the estimate row and the job\'s verify row customer', async () => {
    useKey(getKeyStore().create('customer', ['scan']).key);
    const estimate = await server.inject({ method: 'POST', url: '/scan/full/estimate', headers, payload: { text: TEXT, provider: 'mock' } });
    expect(estimate.statusCode).toBe(200);
    const started = await server.inject({
      method: 'POST', url: '/scan/full',
      headers: { ...headers, 'idempotency-key': 'spend-key-class-0001' },
      payload: { estimateId: estimate.json().estimateId },
    });
    expect(started.statusCode, started.body).toBeLessThan(300);
    await waitForRows(2);
    const rows = spendRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.keyClass)).toEqual(['customer', 'customer']);
    expect(rows[0].stage).toBe('extraction');
    expect(rows[1]).not.toHaveProperty('stage');
  });

  it('a full-scan estimate row is marked as extraction; other rows carry no stage', async () => {
    await CASES.find((x) => x.name === 'POST /scan/full/estimate')!.run();
    await CASES.find((x) => x.name === 'POST /scan')!.run();
    const rows = spendRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].stage).toBe('extraction');
    expect(rows[1]).not.toHaveProperty('stage');
  });
});

describe('a scan that fails after spending is still ledgered', () => {
  it('POST /scan with pipelineConfig: extraction fails after a billed call, one row, no claims', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan', headers, payload: { text: `${TEXT} ${EXTRACT_FAILS}`, provider: 'mock', pipelineConfig: { extractionProvider: 'mock' } } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('extraction_failed');
    const rows = spendRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ claimCount: 0, verifiedCount: 0 });
    expect(rows[0].costUsd as number).toBeGreaterThan(0);
  });

  it('POST /scan/stream: extraction fails after a billed call, one row', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan/stream', headers, payload: { text: `${TEXT} ${EXTRACT_FAILS}`, provider: 'mock' } });
    expect(res.body).toContain('extraction_failed');
    expect(spendRows()).toHaveLength(1);
  });

  it('POST /critique: the critique call fails after a billed call, one row', async () => {
    const res = await server.inject({
      method: 'POST', url: '/critique', headers,
      payload: {
        text: `${TEXT} ${EXTRACT_FAILS}`, provider: 'mock',
        claims: [{ id: 'c1', text: 'Paris is in France', type: 'fact', importance: 3 }],
        verifications: { c1: { claimId: 'c1', status: 'contradicted', explanation: 'no', sources: [] } },
      },
    });
    expect(res.statusCode).toBe(500);
    expect(spendRows()).toHaveLength(1);
  });

  it('POST /admin/verify-claims: a claim whose call fails after a billed call still counts toward the row', async () => {
    const res = await server.inject({ method: 'POST', url: '/admin/verify-claims', headers, payload: { claims: [{ id: 'c1', text: `Paris ${EXTRACT_FAILS}` }], provider: 'mock' } });
    expect(res.statusCode).toBe(200);
    // The mock provider prices at $0 without captured usage, so the row exists only if the failed call's usage was kept.
    const rows = spendRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].costUsd as number).toBeGreaterThan(0);
  });

  it('POST /scan: a missing provider key spends nothing and writes no row', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await server.inject({ method: 'POST', url: '/scan', headers, payload: { text: TEXT, provider: 'openai', pipelineConfig: { extractionProvider: 'openai' } } });
      expect(res.statusCode).toBe(503);
      expect(spendRows()).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});
