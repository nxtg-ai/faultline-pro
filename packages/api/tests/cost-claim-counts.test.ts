// Validates: GoPMO 1.18.11.7.3, per-claim cost instrument. The scan-cost log and
// the managed cost event carry claims extracted and claims with a provider verdict,
// so cost per claim (p50/p90/p99) can be read from production rows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { buildManagedCostEvent, getCostStore, resetCostStore, scanCostLogRow, loadScanCostLog } from '../src/store/costs.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetCache } from '../src/store/cache.js';

const ADMIN = 'cost-count-admin';

describe('cost event and log row carry claim counts', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'faultline-costcount-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('the event and the log row hold extracted and verified counts; old rows hydrate without them', () => {
    const event = buildManagedCostEvent([], { text: 'x', provider: 'mock', claimCount: 3, tier: 'pro', latencyMs: 5, claims: { extracted: 4, verified: 3 } });
    expect(event).toMatchObject({ claimsExtracted: 4, claimsVerified: 3 });
    const row = JSON.parse(scanCostLogRow(event));
    expect(row).toMatchObject({ claim_count: 4, verified_count: 3 });

    // An event read back from a row written before counts existed carries neither count.
    const { claimsExtracted: _e, claimsVerified: _v, ...legacyEvent } = buildManagedCostEvent([], { text: 'y', provider: 'mock', claimCount: 1, tier: 'pro', latencyMs: 5, claims: { extracted: 1, verified: 1 } });
    const old = JSON.parse(scanCostLogRow(legacyEvent));
    expect(old).toMatchObject({ claim_count: null, verified_count: null });
    const path = join(dir, 'scan-cost.jsonl');
    writeFileSync(path, [JSON.stringify(row), JSON.stringify(old)].join('\n') + '\n');
    const [withCounts, without] = loadScanCostLog(path);
    expect(withCounts).toMatchObject({ claimsExtracted: 4, claimsVerified: 3 });
    expect(without.claimsExtracted).toBeUndefined();
    expect(without.claimsVerified).toBeUndefined();
  });
});

describe('POST /scan records its claim counts', () => {
  let server: FastifyInstance;
  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    resetCostStore(); resetKeyStore(); resetCache();
    server = buildServer();
    await server.ready();
  });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('a mock scan logs claims extracted and claims with a verdict', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan', headers: { 'x-api-key': ADMIN, 'content-type': 'application/json' }, payload: { text: 'The Eiffel Tower is in Paris. Water boils at 100 C at sea level.', provider: 'mock' } });
    expect(res.statusCode).toBe(200);
    const claims = JSON.parse(res.body).claims.length;
    expect(claims).toBeGreaterThan(0);
    const events = getCostStore().getManagedEvents(1);
    expect(events.length).toBe(1);
    expect(events[0].claimsExtracted).toBe(claims);
    expect(events[0].claimsVerified).toBe(claims);
  });
});
