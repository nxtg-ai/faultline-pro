// Validates: GET /admin/cost-summary reports provider cost and claim counts by key class over a window.
/**
 * GET /admin/cost-summary and the pieces under it:
 * - classifyKeyId: the key class of each kind of key.
 * - lastCompleteWeek / resolveWindow: the default Monday-to-Monday window.
 * - summarizeSpendByKeyClass: sums over a fixture provider-spend ledger, old rows unlabelled.
 * - ClaimMeter.billedUsageBetween: billed claims from a fixture usage record with a void row.
 * - the route: admin only, 403 for every other key, the measurement key included.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { classifyKeyId, MEASUREMENT_KEY_ID, MEASUREMENT_ROUTES } from '../src/plugins/auth.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getClaimMeter, resetClaimMeter } from '../src/store/claim-meter.js';
import { resetProviderSpendLedger, summarizeSpendByKeyClass, SUMMARY_KEY_CLASSES } from '../src/store/provider-spend.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { COST_SUMMARY_NOTES, lastCompleteWeek, resolveWindow } from '../src/routes/cost-summary.js';

const SERVER_KEY = 'cost-summary-server-key';
const MEASUREMENT_KEY = 'cost-summary-measurement-key';
const ENV_KEYS = ['FAULTLINE_API_KEY', 'FAULTLINE_MEASUREMENT_KEY', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_CLAIM_METER_LEDGER'];

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let spendLedger: string;
let usageLedger: string;

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

/** A spend row in the shape provider-spend.ts writes. */
function spend(ts: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { ts, scanId: 's', month: ts.slice(0, 7), tier: 'pro', provider: 'gemini', costUsd: 0.1, claimCount: 1, verifiedCount: 1, ...fields };
}

const SCAN_A = '11111111-1111-4111-8111-111111111111';
const SCAN_B = '22222222-2222-4222-8222-222222222222';

/** A usage row in the shape the claim meter writes. */
function usage(seq: number, ts: string, scanId: string, claimId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq, ts, period: ts.slice(0, 7), kind: 'usage', keyId: 'cust-key', stripeCustomerId: null,
    scanId, claimId, verdict: 'supported', provider: 'gemini', identifier: `${scanId}:${claimId}`, ...extra,
  };
}

function voidOf(seq: number, ts: string, scanId: string, claimId: string): Record<string, unknown> {
  return usage(seq, ts, scanId, claimId, { kind: 'void', identifier: `void:${scanId}:${claimId}`, voids: `${scanId}:${claimId}` });
}

// The window every fixture uses: the week of Monday 2026-10-19.
const FROM = '2026-10-19T00:00:00.000Z';
const TO = '2026-10-26T00:00:00.000Z';

/**
 * Spend fixture. In the window: two customer rows, one extraction-only customer
 * row, one internal, one measurement, one anonymous, one old row with no keyClass,
 * one row with an unknown keyClass value. Outside: one before, one at `to` (excluded,
 * the window is half-open).
 */
const SPEND_FIXTURE = [
  spend('2026-10-18T23:59:59.999Z', { keyClass: 'customer', costUsd: 9, claimCount: 99, verifiedCount: 99 }),
  spend('2026-10-19T00:00:00.000Z', { keyClass: 'customer', costUsd: 0.25, claimCount: 10, verifiedCount: 6 }),
  spend('2026-10-20T12:00:00.000Z', { keyClass: 'customer', costUsd: 0.5, claimCount: 4, verifiedCount: null }),
  spend('2026-10-20T12:30:00.000Z', { keyClass: 'customer', stage: 'extraction', costUsd: 0.05, claimCount: 7, verifiedCount: 0 }),
  spend('2026-10-21T08:00:00.000Z', { keyClass: 'internal', costUsd: 1.0, claimCount: 3, verifiedCount: 2 }),
  spend('2026-10-22T08:00:00.000Z', { keyClass: 'measurement', costUsd: 2.0, claimCount: 25, verifiedCount: 20 }),
  spend('2026-10-23T08:00:00.000Z', { keyClass: 'anonymous', costUsd: 0.01, claimCount: null, verifiedCount: null }),
  'not json',
  spend('2026-10-24T08:00:00.000Z', { costUsd: 0.3, claimCount: 2, verifiedCount: 1 }),
  spend('2026-10-24T09:00:00.000Z', { keyClass: 'vip', costUsd: 0.2, claimCount: 1, verifiedCount: 1 }),
  spend('2026-10-26T00:00:00.000Z', { keyClass: 'customer', costUsd: 9, claimCount: 99, verifiedCount: 99 }),
];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-cost-summary-'));
  spendLedger = join(tmpDir, 'provider-spend.jsonl');
  usageLedger = join(tmpDir, 'claim-meter.jsonl');
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_MEASUREMENT_KEY = MEASUREMENT_KEY;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = spendLedger;
  process.env.FAULTLINE_CLAIM_METER_LEDGER = usageLedger;
  resetKeyStore();
  resetClaimMeter();
  resetProviderSpendLedger();
  resetRateLimiter();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetKeyStore();
  resetClaimMeter();
  resetProviderSpendLedger();
});

describe('classifyKeyId: the key class of each kind of key', () => {
  it('the measurement key is measurement', () => {
    expect(classifyKeyId(MEASUREMENT_KEY_ID)).toBe('measurement');
  });

  it('the env server key (also the web server key) is internal', () => {
    expect(classifyKeyId('admin')).toBe('internal');
  });

  it('a keystore key with the admin permission is internal', () => {
    const key = getKeyStore().create('ops', ['scan', 'admin']);
    expect(classifyKeyId(key.id)).toBe('internal');
  });

  it('a keystore key without admin is customer, pro or not', () => {
    expect(classifyKeyId(getKeyStore().create('c', ['scan']).id)).toBe('customer');
    expect(classifyKeyId(getKeyStore().create('p', ['scan', 'pro']).id)).toBe('customer');
  });

  it('a keystore id that no longer resolves (a deleted key) is customer', () => {
    const key = getKeyStore().create('gone', ['scan']);
    getKeyStore().delete(key.id);
    expect(classifyKeyId(key.id)).toBe('customer');
  });

  it('no key, an empty id and the "unknown" placeholder are anonymous', () => {
    expect(classifyKeyId(undefined)).toBe('anonymous');
    expect(classifyKeyId(null)).toBe('anonymous');
    expect(classifyKeyId('')).toBe('anonymous');
    expect(classifyKeyId('unknown')).toBe('anonymous');
  });
});

describe('the window', () => {
  it('defaults to the last complete Monday-to-Monday week (a Wednesday)', () => {
    const w = lastCompleteWeek(new Date('2026-10-28T15:30:00Z'));
    expect(w.from.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('at exactly Monday 00:00Z the week that just ended is the window', () => {
    const w = lastCompleteWeek(new Date('2026-10-26T00:00:00.000Z'));
    expect(w.from.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('one millisecond before Monday 00:00Z (Sunday night) the window is the week before', () => {
    const w = lastCompleteWeek(new Date('2026-10-25T23:59:59.999Z'));
    expect(w.from.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('a Monday mid-day still ends the window at that Monday 00:00Z', () => {
    const w = lastCompleteWeek(new Date('2026-10-26T09:00:00Z'));
    expect(w.to.toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('crosses a month and a year boundary', () => {
    const w = lastCompleteWeek(new Date('2027-01-02T10:00:00Z'));
    expect(w.from.toISOString()).toBe('2026-12-21T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-12-28T00:00:00.000Z');
  });

  it('from and to given are used as given; one given makes a one-week window', () => {
    const both = resolveWindow({ from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' });
    expect(both).toMatchObject({ ok: true });
    if (both.ok) expect([both.from.toISOString(), both.to.toISOString()]).toEqual(['2026-10-01T00:00:00.000Z', '2026-10-03T00:00:00.000Z']);
    const fromOnly = resolveWindow({ from: '2026-10-01T00:00:00Z' });
    if (fromOnly.ok) expect(fromOnly.to.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    else throw new Error('from-only window refused');
    const toOnly = resolveWindow({ to: '2026-10-08T00:00:00Z' });
    if (toOnly.ok) expect(toOnly.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    else throw new Error('to-only window refused');
  });

  it('refuses a non-ISO value and a window that does not run forward', () => {
    expect(resolveWindow({ from: 'last tuesday' })).toEqual({ ok: false, error: 'from must be an ISO-8601 timestamp' });
    expect(resolveWindow({ to: '1700000000' })).toEqual({ ok: false, error: 'to must be an ISO-8601 timestamp' });
    expect(resolveWindow({ from: TO, to: FROM })).toEqual({ ok: false, error: 'from must be before to' });
    expect(resolveWindow({ from: FROM, to: FROM })).toEqual({ ok: false, error: 'from must be before to' });
  });
});

describe('summarizeSpendByKeyClass: sums over a fixture ledger', () => {
  it('sums cost, calls and claim counts per class over [from, to)', async () => {
    writeJsonl(spendLedger, SPEND_FIXTURE);
    const sums = await summarizeSpendByKeyClass(new Date(FROM), new Date(TO));
    expect(Object.keys(sums).sort()).toEqual([...SUMMARY_KEY_CLASSES].sort());
    // Two counted rows plus the extraction-only row: its cost counts, its claims do not.
    expect(sums.customer).toEqual({ costUsd: 0.8, calls: 3, claimsHandled: 14, billableClaims: 6 });
    expect(sums.internal).toEqual({ costUsd: 1, calls: 1, claimsHandled: 3, billableClaims: 2 });
    expect(sums.measurement).toEqual({ costUsd: 2, calls: 1, claimsHandled: 25, billableClaims: 20 });
    expect(sums.anonymous).toEqual({ costUsd: 0.01, calls: 1, claimsHandled: 0, billableClaims: 0 });
  });

  it('rows with no keyClass (written before the field) and unknown values count as unlabelled', async () => {
    writeJsonl(spendLedger, SPEND_FIXTURE);
    const sums = await summarizeSpendByKeyClass(new Date(FROM), new Date(TO));
    expect(sums.unlabelled).toEqual({ costUsd: 0.5, calls: 2, claimsHandled: 3, billableClaims: 2 });
  });

  it('a window with no rows, and a ledger that does not exist, sum to zero in every class', async () => {
    writeJsonl(spendLedger, SPEND_FIXTURE);
    const empty = await summarizeSpendByKeyClass(new Date('2025-01-06T00:00:00Z'), new Date('2025-01-13T00:00:00Z'));
    for (const c of SUMMARY_KEY_CLASSES) expect(empty[c]).toEqual({ costUsd: 0, calls: 0, claimsHandled: 0, billableClaims: 0 });
    const missing = await summarizeSpendByKeyClass(new Date(FROM), new Date(TO), join(tmpDir, 'nope.jsonl'));
    for (const c of SUMMARY_KEY_CLASSES) expect(missing[c].calls).toBe(0);
  });
});

describe('ClaimMeter.billedUsageBetween: billed claims from the usage record', () => {
  it('counts usage rows in the window and drops a voided one, even when the void lands after the window', () => {
    writeJsonl(usageLedger, [
      { kind: 'header', ledgerId: 'fixture', version: 1, createdAt: '2026-10-01T00:00:00Z' },
      usage(1, '2026-10-18T10:00:00.000Z', SCAN_A, 'c0'), // before the window
      usage(2, '2026-10-19T10:00:00.000Z', SCAN_A, 'c1'),
      usage(3, '2026-10-19T10:00:00.000Z', SCAN_A, 'c2'),
      usage(4, '2026-10-20T10:00:00.000Z', SCAN_B, 'c1'),
      voidOf(5, '2026-10-21T10:00:00.000Z', SCAN_A, 'c2'), // voids a row in the window, inside it
      usage(6, '2026-10-22T10:00:00.000Z', SCAN_B, 'c2'),
      voidOf(7, '2026-10-27T10:00:00.000Z', SCAN_B, 'c2'), // voids a row in the window, after it
      usage(8, '2026-10-26T00:00:00.000Z', SCAN_B, 'c3'), // at `to`: outside
    ]);
    // In the window: A:c1, A:c2 (voided), B:c1, B:c2 (voided). Billed: 2. Void rows never count.
    expect(getClaimMeter().billedUsageBetween(new Date(FROM), new Date(TO))).toBe(2);
  });

  it('is zero with no usage record', () => {
    expect(getClaimMeter().billedUsageBetween(new Date(FROM), new Date(TO))).toBe(0);
  });
});

describe('GET /admin/cost-summary', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  const get = (key: string | undefined, query = `?from=${FROM}&to=${TO}`) => server.inject({
    method: 'GET', url: `/admin/cost-summary${query}`, headers: key === undefined ? {} : { 'x-api-key': key },
  });

  it('the server key gets the summary: per-class sums, billed and unbilled customer claims, notes', async () => {
    writeJsonl(spendLedger, SPEND_FIXTURE);
    writeJsonl(usageLedger, [
      usage(1, '2026-10-19T10:00:00.000Z', SCAN_A, 'c1'),
      usage(2, '2026-10-19T10:00:00.000Z', SCAN_A, 'c2'),
      usage(3, '2026-10-20T10:00:00.000Z', SCAN_A, 'c3'),
      voidOf(4, '2026-10-20T11:00:00.000Z', SCAN_A, 'c3'),
    ]);
    const res = await get(SERVER_KEY);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.from).toBe(FROM);
    expect(body.to).toBe(TO);
    expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
    expect(Object.keys(body.classes).sort()).toEqual(['anonymous', 'customer', 'internal', 'measurement', 'unlabelled']);
    expect(body.classes.customer).toEqual({ costUsd: 0.8, calls: 3, claimsHandled: 14, billableClaims: 6 });
    expect(body.classes.unlabelled.calls).toBe(2);
    expect(body.customerBilledClaims).toBe(2);
    expect(body.customerUnbilledClaims).toBe(12);
    expect(body.notes).toEqual([...COST_SUMMARY_NOTES]);
    expect(body.notes.length).toBeGreaterThan(0);
  });

  it('unbilled claims floor at 0 when more claims were billed than spend rows handled', async () => {
    writeJsonl(usageLedger, [usage(1, '2026-10-19T10:00:00.000Z', SCAN_A, 'c1')]);
    const res = await get(SERVER_KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json().customerBilledClaims).toBe(1);
    expect(res.json().customerUnbilledClaims).toBe(0);
  });

  it('with no query it reports the last complete week, and an empty window is all zeros', async () => {
    const res = await get(SERVER_KEY, '');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const expected = lastCompleteWeek(new Date());
    expect(body.from).toBe(expected.from.toISOString());
    expect(body.to).toBe(expected.to.toISOString());
    for (const c of SUMMARY_KEY_CLASSES) expect(body.classes[c]).toEqual({ costUsd: 0, calls: 0, claimsHandled: 0, billableClaims: 0 });
    expect(body.customerBilledClaims).toBe(0);
    expect(body.customerUnbilledClaims).toBe(0);
  });

  it('a keystore key with the admin permission gets the summary', async () => {
    const key = getKeyStore().create('ops', ['scan', 'admin']);
    expect((await get(key.key)).statusCode).toBe(200);
  });

  it('400 for a bad timestamp or a backwards window', async () => {
    expect((await get(SERVER_KEY, '?from=yesterday')).statusCode).toBe(400);
    expect((await get(SERVER_KEY, `?from=${TO}&to=${FROM}`)).statusCode).toBe(400);
  });

  it('400 for an impossible calendar date or time, never a shifted window', async () => {
    for (const bad of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-04-31', '2026-10-01T24:00:00Z', '2026-10-01T10:60:00Z', '2026-10-01T10:00:60Z', '2026-10-01T10:00:00+24:00']) {
      expect(resolveWindow({ from: bad }).ok).toBe(false);
      expect((await get(SERVER_KEY, `?from=${encodeURIComponent(bad)}&to=2026-12-01`)).statusCode).toBe(400);
    }
    for (const ok of ['0000-02-29', '0001-01-01', '0099-12-31T23:59:59.123456789+14:00']) expect(resolveWindow({ from: ok }).ok).toBe(true);
    const leap = resolveWindow({ from: '2028-02-29', to: '2028-03-07' });
    expect(leap.ok && leap.from.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('403 for a customer key, a pro key and a key holding usage:read', async () => {
    const customer = getKeyStore().create('c', ['scan']);
    const pro = getKeyStore().create('p', ['scan', 'pro']);
    expect((await get(customer.key)).statusCode).toBe(403);
    expect((await get(pro.key)).statusCode).toBe(403);
    const reader = getKeyStore().create('r', ['scan']);
    const scoped = getKeyStore().list().find((k) => k.id === reader.id)!;
    scoped.scopes = ['usage:read'];
    expect((await get(reader.key)).statusCode).toBe(403);
  });

  it('403 for the measurement key, which is not on its allowlist', async () => {
    expect(MEASUREMENT_ROUTES).not.toContain('GET /admin/cost-summary');
    expect((await get(MEASUREMENT_KEY)).statusCode).toBe(403);
  });

  it('403 with no key, and the summary never contains a key id', async () => {
    expect((await get(undefined)).statusCode).toBe(403);
    const customer = getKeyStore().create('c', ['scan']);
    writeJsonl(spendLedger, SPEND_FIXTURE);
    const res = await get(SERVER_KEY);
    expect(res.body).not.toContain(customer.id);
    expect(res.body).not.toContain('cust-key');
  });
});
