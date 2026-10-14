// Validates: N-234 (verdict states enforced at every API write path, GoPMO 1.18.11.3 P2; EP4 recert 02-codex-evidence.md row 1)
/**
 * Every fp API path that stores a verdict refuses one outside the allowlist.
 *
 * The examiner's probe A1 mocked the engine at its module boundary so a result
 * carrying the status ROYALLY_CERTIFIED reached the real Fastify route, cache,
 * history and claim index, and came back on a cache hit. These tests replay that
 * probe, then hit each store's write method directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PROBE = 'ROYALLY_CERTIFIED';
const { mockScan, real } = vi.hoisted(() => ({ mockScan: vi.fn(), real: { scan: null as null | ((...a: unknown[]) => Promise<unknown>) } }));
vi.mock('@nxtg/faultline/cli/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/cli/scan.js')>();
  real.scan = actual.scan as never;
  return { ...actual, scan: mockScan };
});

import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { getScanCache, resetCache } from '../src/store/cache.js';
import { getScanStore, resetScanStore } from '../src/store/scans.js';
import { getScanHistory, resetScanHistory } from '../src/store/scan-history.js';
import { getClaimIndex, resetClaimIndex } from '../src/store/claims.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';

const CLAIM = { id: 'c1', text: 'Fixture fact for the allowlist.', type: 'fact', importance: 5 };

function result(status: string, overallRisk = 'low'): Record<string, unknown> {
  return {
    claims: [CLAIM],
    verifications: { c1: { claimId: 'c1', status, explanation: 'fixture', sources: [] } },
    overallRisk,
    provider: 'mock',
    ruleFindings: [],
  };
}

const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-allowlist-'));
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  resetKeyStore();
  resetCache();
  resetScanStore();
  resetScanHistory();
  resetClaimIndex();
  resetProviderSpendLedger();
  resetGroundingAllowanceLedger();
  mockScan.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  uninstallGroundingCounter();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /scan: the examiner probe A1', () => {
  it('a verdict outside the allowlist gets 502 invalid_verdict, and nothing is stored or cached', async () => {
    mockScan.mockResolvedValue(result(PROBE));
    const server = buildServer();
    await server.ready();
    try {
      const apiKey = getKeyStore().create('Pro', ['pro', 'scan']).key;
      const req = { method: 'POST' as const, url: '/scan', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, payload: { text: 'Fixture fact for the allowlist.', provider: 'mock' } };
      const a = await server.inject(req);
      expect(a.statusCode).toBe(502);
      expect(a.json()).toEqual({ error: 'An unexpected error occurred.', code: 'invalid_verdict' });
      expect(a.body).not.toContain(PROBE);

      // Nothing was cached: the second request runs the engine again.
      const b = await server.inject(req);
      expect(b.statusCode).toBe(502);
      expect(b.headers['x-cache']).toBe('MISS');
      expect(mockScan).toHaveBeenCalledTimes(2);
      expect(getScanHistory().size).toBe(0);
      expect(getClaimIndex().getStats().totalClaims).toBe(0);

      // A valid result from the real (mock-provider) engine is stored and served as before.
      mockScan.mockImplementation((...args: unknown[]) => real.scan!(...args));
      const c = await server.inject(req);
      expect(c.statusCode).toBe(200);
      const statuses = Object.values(c.json().verifications as Record<string, { status: string }>).map((v) => v.status);
      expect(statuses.length).toBeGreaterThan(0);
      expect(getScanHistory().size).toBe(1);
      expect(getClaimIndex().getStats().totalClaims).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  }, 30_000);
});

describe('each store refuses an invalid verdict at its write method', () => {
  it('scan store', () => {
    expect(() => getScanStore().record('k', 'text', result(PROBE))).toThrow(/invalid verdict/);
    expect(() => getScanStore().record('k', 'text', result('supported', 'edited'))).toThrow(/overallRisk/);
    expect(getScanStore().list('k')).toHaveLength(0);
    getScanStore().record('k', 'text', result('mixed'));
    expect(getScanStore().list('k')).toHaveLength(1);
  });

  it('scan cache', () => {
    expect(() => getScanCache().set('k', 'text', 'mock', result(PROBE) as never)).toThrow(/invalid verdict/);
    expect(getScanCache().get('k', 'text', 'mock')).toBeNull();
    getScanCache().set('k', 'text', 'mock', result('contradicted') as never);
    expect(getScanCache().get('k', 'text', 'mock')).not.toBeNull();
  });

  it('claim index', () => {
    const verifications = (result(PROBE).verifications) as Record<string, { status?: string }>;
    expect(() => getClaimIndex().ingest([CLAIM], verifications, 'scan-1')).toThrow(/invalid verdict/);
    expect(getClaimIndex().getStats().totalClaims).toBe(0);
    getClaimIndex().ingest([CLAIM], (result('unverified').verifications) as never, 'scan-2');
    expect(getClaimIndex().getStats().totalClaims).toBe(1);
  });
});
