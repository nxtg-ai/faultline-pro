// Validates: node 1.18.11.7.6 (claim meter: ledger, reservations, hydration, dedupe)
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ClaimMeter,
  claimIdentifier,
  defaultClaimCap,
  getClaimMeter,
  isBillableVerdict,
  resetClaimMeter,
  type ClaimMeterRow,
} from '../src/store/claim-meter.js';
import { billableClaims, meteredScan, ClaimCapReachedError } from '../src/lib/claim-meter.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';

const ENV_KEYS = ['FAULTLINE_CLAIM_METER_LEDGER', 'FAULTLINE_CLAIM_METER_SYNC_LEDGER', 'FAULTLINE_DEFAULT_CLAIM_CAP'];
let saved: Record<string, string | undefined>;
let dir: string;
let ledger: string;
let syncLedger: string;

const NOW = new Date('2026-10-15T12:00:00Z');
const supported = (claimId: string) => ({ claimId, verdict: 'supported', provider: 'mock' });

function rows(): ClaimMeterRow[] {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ClaimMeterRow);
}

beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-claim-meter-'));
  ledger = join(dir, 'claim-meter.jsonl');
  syncLedger = join(dir, 'claim-meter-sync.jsonl');
  process.env.FAULTLINE_CLAIM_METER_LEDGER = ledger;
  process.env.FAULTLINE_CLAIM_METER_SYNC_LEDGER = syncLedger;
  delete process.env.FAULTLINE_DEFAULT_CLAIM_CAP;
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

describe('billable verdicts', () => {
  it('bills supported, contradicted, mixed and unverified; not apiError, skipped, loading or garbage', () => {
    expect(isBillableVerdict({ status: 'supported' })).toBe(true);
    expect(isBillableVerdict({ status: 'contradicted' })).toBe(true);
    expect(isBillableVerdict({ status: 'mixed' })).toBe(true);
    expect(isBillableVerdict({ status: 'unverified' })).toBe(true);
    expect(isBillableVerdict({ status: 'unverified', apiError: true })).toBe(false);
    expect(isBillableVerdict({ status: 'skipped' })).toBe(false);
    expect(isBillableVerdict({ status: 'loading' })).toBe(false);
    expect(isBillableVerdict({ status: 'pwned' as never })).toBe(false);
    expect(isBillableVerdict(undefined)).toBe(false);
  });

  it('billableClaims reads a scan result, takes the provider from provenance, and skips provider errors', () => {
    const claims = billableClaims({
      verifications: {
        c1: { status: 'supported', provenance: { provider: 'gemini', model: 'm', verifiedAt: 'x' } },
        c2: { status: 'unverified' },
        c3: { status: 'unverified', apiError: true },
      },
    }, 'openai');
    expect(claims).toEqual([
      { claimId: 'c1', verdict: 'supported', provider: 'gemini' },
      { claimId: 'c2', verdict: 'unverified', provider: 'openai' },
    ]);
    expect(billableClaims(null, 'x')).toEqual([]);
    expect(billableClaims({ verifications: 'nope' }, 'x')).toEqual([]);
  });
});

describe('defaultClaimCap', () => {
  it('reads a non-negative integer, else null (refuse)', () => {
    expect(defaultClaimCap()).toBeNull();
    process.env.FAULTLINE_DEFAULT_CLAIM_CAP = '250';
    expect(defaultClaimCap()).toBe(250);
    process.env.FAULTLINE_DEFAULT_CLAIM_CAP = '0';
    expect(defaultClaimCap()).toBe(0);
    for (const bad of ['-1', '2.5', 'lots', 'Infinity']) {
      process.env.FAULTLINE_DEFAULT_CLAIM_CAP = bad;
      expect(defaultClaimCap()).toBeNull();
    }
  });
});

describe('reserve, commit, release', () => {
  it('refuses when used + reserved + requested > cap, with the 402 numbers', () => {
    const meter = new ClaimMeter();
    const first = meter.reserve('k1', 8, 10, NOW);
    expect(first.ok).toBe(true);
    const second = meter.reserve('k1', 8, 10, NOW);
    expect(second).toEqual({ ok: false, cap: 10, used: 0, remaining: 2 });
    expect(meter.reserve('k1', 2, 10, NOW).ok).toBe(true); // exactly at the cap fits
    expect(meter.reservedFor('k1')).toBe(10);
  });

  it('commits only what was given and releases the unused part (3 claims under an 8 reservation)', () => {
    const meter = new ClaimMeter();
    const outcome = meter.reserve('k1', 8, 100, NOW);
    if (!outcome.ok) throw new Error('reserve refused');
    expect(outcome.reservation.commit('scan-1', [supported('c1'), supported('c2'), { claimId: 'c3', verdict: 'unverified', provider: 'mock' }])).toBe(3);
    expect(meter.reservedFor('k1')).toBe(5);
    outcome.reservation.release();
    outcome.reservation.release(); // idempotent
    expect(meter.reservedFor('k1')).toBe(0);
    expect(meter.usageFor('k1', '2026-10')).toEqual({ used: 3, byVerdict: { supported: 2, unverified: 1 } });
    expect(rows().map((r) => r.identifier)).toEqual(['scan-1:c1', 'scan-1:c2', 'scan-1:c3']);
    expect(rows()[0]).toMatchObject({ period: '2026-10', keyId: 'k1', scanId: 'scan-1', claimId: 'c1', verdict: 'supported', provider: 'mock' });
  });

  it('keeps keys apart', () => {
    const meter = new ClaimMeter();
    expect(meter.reserve('k1', 8, 8, NOW).ok).toBe(true);
    expect(meter.reserve('k2', 8, 8, NOW).ok).toBe(true);
    expect(meter.reserve('k1', 1, 8, NOW).ok).toBe(false);
  });

  it('a cap of 0 refuses any claim', () => {
    const meter = new ClaimMeter();
    expect(meter.reserve('k1', 1, 0, NOW)).toEqual({ ok: false, cap: 0, used: 0, remaining: 0 });
  });

  it('counts committed usage against the cap in later reservations', () => {
    const meter = new ClaimMeter();
    const r = meter.reserve('k1', 8, 10, NOW);
    if (!r.ok) throw new Error('refused');
    r.reservation.commit('s', [supported('c1'), supported('c2'), supported('c3')]);
    r.reservation.release();
    expect(meter.reserve('k1', 8, 10, NOW)).toEqual({ ok: false, cap: 10, used: 3, remaining: 7 });
    expect(meter.reserve('k1', 7, 10, NOW).ok).toBe(true);
  });

  it('a new month starts from zero', () => {
    const meter = new ClaimMeter();
    const r = meter.reserve('k1', 2, 2, new Date('2026-09-30T23:00:00Z'));
    if (!r.ok) throw new Error('refused');
    r.reservation.commit('s', [supported('c1'), supported('c2')]);
    r.reservation.release();
    expect(meter.reserve('k1', 1, 2, new Date('2026-09-30T23:30:00Z')).ok).toBe(false);
    expect(meter.reserve('k1', 2, 2, new Date('2026-10-01T00:00:01Z')).ok).toBe(true);
  });
});

describe('the ledger is the authority', () => {
  it('a rebuilt meter hydrates usage from the file (a deploy cannot reset the month)', () => {
    const before = getClaimMeter();
    const r = before.reserve('k1', 8, 10, NOW);
    if (!r.ok) throw new Error('refused');
    r.reservation.commit('scan-a', [supported('c1'), supported('c2'), { claimId: 'c3', verdict: 'contradicted', provider: 'mock' }]);
    r.reservation.release();

    resetClaimMeter();
    const after = getClaimMeter();
    expect(after).not.toBe(before);
    expect(after.usageFor('k1', '2026-10')).toEqual({ used: 3, byVerdict: { supported: 2, contradicted: 1 } });
    expect(after.reserve('k1', 8, 10, NOW)).toEqual({ ok: false, cap: 10, used: 3, remaining: 7 });
  });

  it('a duplicate identifier is counted and written once (in one commit, across commits, across a restart)', () => {
    const meter = getClaimMeter();
    const r = meter.reserve('k1', 8, 100, NOW);
    if (!r.ok) throw new Error('refused');
    expect(r.reservation.commit('scan-a', [supported('c1'), supported('c1')])).toBe(1);
    expect(r.reservation.commit('scan-a', [supported('c1')])).toBe(0);
    r.reservation.release();
    expect(rows()).toHaveLength(1);

    // The same row twice in the file (a replayed append) still counts once.
    writeFileSync(ledger, readFileSync(ledger, 'utf8') + readFileSync(ledger, 'utf8'));
    resetClaimMeter();
    expect(getClaimMeter().usageFor('k1', '2026-10').used).toBe(1);
    expect(getClaimMeter().lag(NOW).meterSyncLagRows).toBe(1);
  });

  it('skips corrupt and partial lines when hydrating', () => {
    const good: ClaimMeterRow = {
      ts: NOW.toISOString(), period: '2026-10', keyId: 'k1', scanId: 's', claimId: 'c1', verdict: 'supported',
      provider: 'mock', identifier: claimIdentifier('s', 'c1'),
    };
    writeFileSync(ledger, ['{not json', JSON.stringify({ ...good, identifier: undefined }), JSON.stringify(good), ''].join('\n'));
    expect(getClaimMeter().usageFor('k1', '2026-10').used).toBe(1);
  });

  it('a failed write never throws; the row still counts and the failure is surfaced', () => {
    process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'missing-parent-is-a-file', 'claim-meter.jsonl');
    writeFileSync(join(dir, 'missing-parent-is-a-file'), 'x');
    const meter = new ClaimMeter();
    const r = meter.reserve('k1', 1, 1, NOW);
    if (!r.ok) throw new Error('refused');
    expect(r.reservation.commit('s', [supported('c1')])).toBe(1);
    expect(meter.getWriteFailures()).toBe(1);
    expect(meter.totals('2026-10')).toMatchObject({ used: 1, ledgerWriteFailures: 1 });
  });
});

describe('sync lag', () => {
  it('counts unsent rows and the oldest unsent age; sent markers survive a restart', () => {
    const meter = getClaimMeter();
    const r = meter.reserve('k1', 3, 10, NOW);
    if (!r.ok) throw new Error('refused');
    meter.append('k1', '2026-10', 'old', [supported('c1')], new Date('2026-10-15T11:00:00Z'));
    r.reservation.commit('new', [supported('c1'), supported('c2')]);
    r.reservation.release();

    expect(meter.lag(NOW)).toMatchObject({ meterSyncLagRows: 3, oldestUnsentAt: '2026-10-15T11:00:00.000Z', oldestUnsentAgeSeconds: 3600 });
    meter.markSent('old:c1', NOW);
    meter.markSent('old:c1', NOW); // once
    expect(meter.lag(NOW).meterSyncLagRows).toBe(2);
    expect(readFileSync(syncLedger, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);

    resetClaimMeter();
    expect(getClaimMeter().lag(NOW).meterSyncLagRows).toBe(2);
    expect(getClaimMeter().unsentRows().map((row) => row.identifier)).toEqual(['new:c1', 'new:c2']);
  });

  it('reports no lag on an empty ledger', () => {
    expect(getClaimMeter().lag(NOW)).toEqual({ meterSyncLagRows: 0, oldestUnsentAt: null, oldestUnsentAgeSeconds: null, syncWriteFailures: 0 });
  });
});

describe('totals', () => {
  it('sums keys, verdicts and open reservations for one period', () => {
    const meter = getClaimMeter();
    meter.append('k1', '2026-10', 's1', [supported('c1'), { claimId: 'c2', verdict: 'unverified', provider: 'mock' }], NOW);
    meter.append('k2', '2026-10', 's2', [supported('c1')], NOW);
    meter.append('k2', '2026-09', 's3', [supported('c1')], NOW);
    meter.reserve('k3', 4, 10, NOW);
    expect(meter.totals('2026-10')).toEqual({
      period: '2026-10', used: 3, reserved: 4, keys: 2, byVerdict: { supported: 2, unverified: 1 }, ledgerWriteFailures: 0,
    });
  });
});

describe('meteredScan (work outside a request)', () => {
  it('refuses before running when the key is over its cap', async () => {
    const key = getKeyStore().create('cust', ['scan'], undefined, { claimCap: 3 });
    let ran = 0;
    await expect(meteredScan(key.id, 8, 'job-1', 'mock', async () => { ran += 1; return {}; })).rejects.toBeInstanceOf(ClaimCapReachedError);
    expect(ran).toBe(0);
  });

  it('commits the verdicts and releases the rest; an error commits nothing and releases', async () => {
    const key = getKeyStore().create('cust', ['scan'], undefined, { claimCap: 20 });
    await meteredScan(key.id, 8, 'job-1', 'mock', async () => ({
      verifications: { c1: { status: 'supported' }, c2: { status: 'unverified', apiError: true } },
    }));
    expect(getClaimMeter().usageFor(key.id).used).toBe(1);
    await expect(meteredScan(key.id, 8, 'job-2', 'mock', async () => { throw new Error('provider down'); })).rejects.toThrow('provider down');
    expect(getClaimMeter().usageFor(key.id).used).toBe(1);
    expect(getClaimMeter().reservedFor(key.id)).toBe(0);
  });

  it('does not meter the server key, admin keys or work with no owner', async () => {
    const admin = getKeyStore().create('ops', ['admin']);
    for (const keyId of ['admin', admin.id, undefined]) {
      await meteredScan(keyId, 8, `job-${String(keyId)}`, 'mock', async () => ({ verifications: { c1: { status: 'supported' } } }));
    }
    expect(rows()).toHaveLength(0);
  });

  it('a customer key without claimCap is refused unless FAULTLINE_DEFAULT_CLAIM_CAP is set', async () => {
    const key = getKeyStore().create('cust', ['scan']);
    await expect(meteredScan(key.id, 1, 'j', 'mock', async () => ({}))).rejects.toMatchObject({ body: { error: 'claim_cap_reached', cap: 0, used: 0, remaining: 0 } });
    process.env.FAULTLINE_DEFAULT_CLAIM_CAP = '5';
    await expect(meteredScan(key.id, 1, 'j', 'mock', async () => ({}))).resolves.toEqual({});
  });
});
