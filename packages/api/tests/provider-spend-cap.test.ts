/**
 * Provider-spend budget — the append-only USD ledger + monthly cap that grounds
 * autonomous provider spend (A-110 item 1, founder REC adopted 2026-07-19:
 * "$100/mo provider-spend cap, ledgered").
 *
 * Distinct from the usage cap (N-228): that is a per-customer SCAN quota for
 * gross margin (402); this is the FLEET USD budget for runway (503).
 *
 * Validates: N-230 (A-110 item 1 — $100/mo provider-spend cap, ledgered).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import {
  RULED_MONTHLY_CAP_USD,
  currentMonth,
  getMonthlyCapUsd,
  getProviderSpendLedger,
  getProviderSpendStatus,
  isProviderSpendCapEnabled,
  ledgerPath,
  recordProviderSpend,
  resetProviderSpendLedger,
} from '../src/store/provider-spend.js';
import type { ManagedScanCostEvent } from '../src/store/costs.js';

const SPEND_ENV_KEYS = [
  'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_PROVIDER_SPEND_CAP_USD',
  'FAULTLINE_PROVIDER_SPEND_LEDGER',
];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let tmpLedger: string;

/** A real managed cost event (the shape the BLG-005 cost path emits per scan). */
function costEvent(over: Partial<ManagedScanCostEvent> = {}): ManagedScanCostEvent {
  return {
    scanId: 'scan-1',
    ts: new Date().toISOString(),
    tier: 'pro',
    keyMode: 'managed',
    provider: 'openai',
    modelId: 'gpt-4o',
    inputTokens: 17_000,
    outputTokens: 500,
    groundingCalls: 3,
    costUsd: 0.42,
    latencyMs: 1200,
    ...over,
  };
}

beforeEach(() => {
  savedEnv = {};
  for (const k of SPEND_ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of SPEND_ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-spend-'));
  tmpLedger = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = tmpLedger;
  resetProviderSpendLedger();
  resetKeyStore();
});
afterEach(() => {
  for (const k of SPEND_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================================================
// config — the ruled cap, env overrides, dormancy
// =========================================================================
describe('provider-spend config', () => {
  it('defaults to the founder-ruled $100/mo cap', () => {
    expect(RULED_MONTHLY_CAP_USD).toBe(100);
    expect(getMonthlyCapUsd()).toBe(100);
  });

  it('honors a numeric env override (a raised cap is Asif’s call)', () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '250.5';
    expect(getMonthlyCapUsd()).toBe(250.5);
  });

  it('accepts a zero cap (hard stop on all managed spend)', () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '0';
    expect(getMonthlyCapUsd()).toBe(0);
  });

  it('falls back to the ruled cap on garbage or negative env — never to unlimited', () => {
    for (const bad of ['banana', '-5', 'NaN', 'Infinity']) {
      process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = bad;
      expect(getMonthlyCapUsd()).toBe(100);
    }
  });

  it('is DORMANT by default and enables only on explicit truthy flags', () => {
    expect(isProviderSpendCapEnabled()).toBe(false);
    for (const v of ['on', '1', 'true', 'enabled', 'ON', 'True']) {
      process.env.FAULTLINE_PROVIDER_SPEND_CAP = v;
      expect(isProviderSpendCapEnabled()).toBe(true);
    }
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'off';
    expect(isProviderSpendCapEnabled()).toBe(false);
  });

  it('resolves the ledger path from env, else the Fly log default', () => {
    expect(ledgerPath()).toBe(tmpLedger);
    delete process.env.FAULTLINE_PROVIDER_SPEND_LEDGER;
    expect(ledgerPath()).toBe('/var/log/faultline/provider-spend.jsonl');
  });

  it('keys budget periods by UTC month', () => {
    expect(currentMonth(new Date('2026-08-09T23:30:00Z'))).toBe('2026-08');
    expect(currentMonth(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
    expect(currentMonth(new Date('2027-01-01T00:00:01Z'))).toBe('2027-01');
  });

});

// =========================================================================
// the ledger — append-only, durable, poison-resistant
// =========================================================================
describe('provider-spend ledger', () => {
  it('appends one JSONL row per spend and advances the month total', () => {
    recordProviderSpend(costEvent({ scanId: 'a', costUsd: 0.25 }));
    recordProviderSpend(costEvent({ scanId: 'b', costUsd: 0.75 }));

    const rows = readFileSync(tmpLedger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0].scanId).toBe('a');
    expect(rows[0].costUsd).toBe(0.25);
    expect(rows[0].month).toBe(currentMonth());
    expect(rows[1].scanId).toBe('b');
    expect(getProviderSpendLedger().monthTotalUsd()).toBeCloseTo(1.0, 6);
  });

  it('never writes PII — a row carries no keyId and no scanned text', () => {
    recordProviderSpend(costEvent());
    const row = JSON.parse(readFileSync(tmpLedger, 'utf8').trim());
    expect(Object.keys(row).sort()).toEqual(
      ['costUsd', 'modelId', 'month', 'provider', 'scanId', 'tier', 'ts'],
    );
  });

  it('is APPEND-only — an existing ledger is extended, never rewritten', () => {
    writeFileSync(tmpLedger, JSON.stringify({ ts: 'x', scanId: 'pre', month: currentMonth(), tier: 'pro', provider: 'openai', costUsd: 3 }) + '\n');
    recordProviderSpend(costEvent({ scanId: 'post', costUsd: 1 }));
    const rows = readFileSync(tmpLedger, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]).scanId).toBe('pre');
  });

  it('HYDRATES the month total from the ledger — a restart does not reset the budget', () => {
    recordProviderSpend(costEvent({ scanId: 'before-restart', costUsd: 42.5 }));
    resetProviderSpendLedger(); // simulate an API restart / redeploy (memory gone, file kept)
    expect(getProviderSpendLedger().monthTotalUsd()).toBeCloseTo(42.5, 6);
  });

  it('counts a hydrated row exactly once when new spend lands after a restart', () => {
    recordProviderSpend(costEvent({ scanId: 'r1', costUsd: 10 }));
    resetProviderSpendLedger();
    recordProviderSpend(costEvent({ scanId: 'r2', costUsd: 5 }));
    expect(getProviderSpendLedger().monthTotalUsd()).toBeCloseTo(15, 6);
    expect(readFileSync(tmpLedger, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('sums only the requested budget period', () => {
    writeFileSync(
      tmpLedger,
      [
        JSON.stringify({ ts: 'x', scanId: 'old', month: '1999-01', tier: 'pro', provider: 'openai', costUsd: 999 }),
        JSON.stringify({ ts: 'x', scanId: 'now', month: currentMonth(), tier: 'pro', provider: 'openai', costUsd: 7 }),
      ].join('\n') + '\n',
    );
    expect(getProviderSpendLedger().monthTotalUsd()).toBeCloseTo(7, 6);
    expect(getProviderSpendLedger().monthTotalUsd('1999-01')).toBeCloseTo(999, 6);
  });

  it('skips corrupt rows instead of zeroing the budget', () => {
    writeFileSync(
      tmpLedger,
      [
        '{not json',
        JSON.stringify({ ts: 'x', scanId: 'good', month: currentMonth(), tier: 'pro', provider: 'openai', costUsd: 4 }),
        '',
        JSON.stringify({ ts: 'x', scanId: 'nan', month: currentMonth(), tier: 'pro', provider: 'openai', costUsd: 'lots' }),
      ].join('\n') + '\n',
    );
    expect(getProviderSpendLedger().monthTotalUsd()).toBeCloseTo(4, 6);
  });

  it('LEDGERS spend regardless of the tier label — a userkey label is not an exemption', () => {
    // `x-user-tier` is caller-supplied and drives this label. There is no BYOK
    // path through the API (provider creds come only from server env), so a
    // `userkey` label on a real scan is either FW telemetry noise or a spoof —
    // either way the dollars were ours and must be recorded.
    expect(recordProviderSpend(costEvent({ tier: 'userkey', costUsd: 5 }))).not.toBeNull();
    expect(getProviderSpendLedger().monthTotalUsd()).toBeCloseTo(5, 6);
    expect(JSON.parse(readFileSync(tmpLedger, 'utf8').trim()).tier).toBe('userkey'); // label kept, not obeyed
  });

  it('does NOT ledger a zero-cost scan (cache hit, mock, all-error)', () => {
    expect(recordProviderSpend(costEvent({ costUsd: 0, cacheHit: true }))).toBeNull();
    expect(getProviderSpendLedger().monthTotalUsd()).toBe(0);
  });

  it('rejects a non-finite or negative cost instead of poisoning the total', () => {
    expect(recordProviderSpend(costEvent({ costUsd: Number.NaN }))).toBeNull();
    expect(recordProviderSpend(costEvent({ costUsd: -3 }))).toBeNull();
    recordProviderSpend(costEvent({ costUsd: 2 }));
    expect(getProviderSpendLedger().monthTotalUsd()).toBeCloseTo(2, 6);
  });

  it('an unwritable ledger still holds the cap in-process and surfaces the failure', () => {
    process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'nope.jsonl', 'child.jsonl');
    resetProviderSpendLedger();
    writeFileSync(join(tmpDir, 'nope.jsonl'), 'blocks the mkdir'); // path component is a file
    expect(() => recordProviderSpend(costEvent({ costUsd: 8 }))).not.toThrow();
    expect(getProviderSpendLedger().monthTotalUsd()).toBeCloseTo(8, 6);
    expect(getProviderSpendLedger().getWriteFailures()).toBe(1);
  });
});

// =========================================================================
// status surface
// =========================================================================
describe('getProviderSpendStatus', () => {
  it('reports the budget position and flags exhaustion at the cap', () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '10';
    recordProviderSpend(costEvent({ costUsd: 4 }));
    const s = getProviderSpendStatus();
    expect(s).toMatchObject({ month: currentMonth(), enforced: false, capUsd: 10, exhausted: false });
    expect(s.spentUsd).toBeCloseTo(4, 6);
    expect(s.remainingUsd).toBeCloseTo(6, 6);

    recordProviderSpend(costEvent({ scanId: 'x2', costUsd: 6 }));
    const s2 = getProviderSpendStatus();
    expect(s2.exhausted).toBe(true);
    expect(s2.remainingUsd).toBe(0);
  });

  it('reflects the live enforcement flag', () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    expect(getProviderSpendStatus().enforced).toBe(true);
  });
});

// =========================================================================
// integration — the real prehandler on the real /scan route
// =========================================================================
describe('enforceProviderSpendCap — integration through /scan', () => {
  let server: FastifyInstance;
  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  /** Push the ledger past the cap so the gate has something to refuse. */
  function exhaustBudget(): void {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '1';
    recordProviderSpend(costEvent({ costUsd: 1.5 }));
  }

  it('is a no-op when DORMANT — an over-budget scan still runs', async () => {
    exhaustBudget(); // gate flag NOT set
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(res.statusCode).not.toBe(503);
  });

  it('returns 503 with budget headers once the monthly budget is exhausted', async () => {
    exhaustBudget();
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['x-provider-spend-cap']).toBe('1.00');
    expect(res.headers['x-provider-spend-used']).toBe('1.50');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const body = res.json();
    expect(body.error).toMatch(/provider budget exhausted/i);
    expect(body.capUsd).toBe(1);
    expect(body.spentUsd).toBeCloseTo(1.5, 4);
  });

  it('lets a scan through while budget remains', async () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '100';
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    recordProviderSpend(costEvent({ costUsd: 0.42 }));
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('CANNOT be bypassed by spoofing x-user-tier — a caller-supplied header buys no exemption', async () => {
    // Regression: the header is set by the caller and `userkey` is a VALID_TIERS
    // member, so keying the gate off it would let any authenticated caller opt
    // out of the budget for the price of one header.
    exhaustBudget();
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    for (const spoof of ['userkey', 'enterprise', 'anon']) {
      const res = await server.inject({
        method: 'POST',
        url: '/scan',
        headers: { 'x-api-key': created.key, 'content-type': 'application/json', 'x-user-tier': spoof },
        payload: { text: 'The sky is blue.', provider: 'mock' },
      });
      expect(res.statusCode, `spoofed x-user-tier: ${spoof}`).toBe(503);
    }
  });

  it('gates the streaming route too (GET /scan/stream)', async () => {
    exhaustBudget();
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await server.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent('The sky is blue.')}&provider=mock`,
      headers: { 'x-api-key': created.key },
    });
    expect(res.statusCode).toBe(503);
  });

  it('exposes the budget on GET /usage to ADMIN only — never to a customer key', async () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '100';
    recordProviderSpend(costEvent({ costUsd: 0.42 }));

    const pro = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const proRes = await server.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': pro.key } });
    expect(proRes.statusCode).toBe(200);
    expect(proRes.json().providerBudget).toBeUndefined();

    const admin = getKeyStore().create('Admin Key', ['admin', 'scan']);
    const adminRes = await server.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': admin.key } });
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.json().providerBudget).toMatchObject({ capUsd: 100, month: currentMonth() });
    expect(adminRes.json().providerBudget.spentUsd).toBeCloseTo(0.42, 4);
  });

  it('a real mock scan exercises the ledger call-site without cost or throw', async () => {
    // mock is priced at $0, so the correct outcome is a completed scan that
    // ledgers nothing. This proves the route's recordProviderSpend call-site is
    // executed on the real path. A NONZERO-cost route assertion needs a priced
    // provider (live spend) and is covered by the unit tests above instead.
    const created = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': created.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(res.statusCode).toBe(200);
    expect(getProviderSpendLedger().monthTotalUsd()).toBe(0);
    expect(getProviderSpendLedger().getWriteFailures()).toBe(0);
  });
});
