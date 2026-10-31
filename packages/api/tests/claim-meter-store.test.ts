// The usage record and the claim cap, at the store and helper level: reserve,
// commit and release, seq and the critical section, duplicate identifiers,
// hydration across a rebuilt store, ledgerId, claimId length, voids, paging,
// and who is metered.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  BILLED_VERDICTS,
  ClaimMeter,
  claimIdentifier,
  getClaimMeter,
  periodResetsAt,
  resetClaimMeter,
  setClaimMeterAppendForTests,
  voidIdentifier,
  MAX_CLAIM_ID_LENGTH,
  type CommittedClaim,
  type UsageRecord,
} from '../src/store/claim-meter.js';
import {
  billableClaims,
  ClaimMeterRefusedError,
  jobRecordScanId,
  meteredScan,
  recordScanId,
  reserveClaimsFor,
} from '../src/lib/claim-meter.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { newJobId } from '../src/store/full-scan-jobs.js';

const ENV_KEYS = ['FAULTLINE_CLAIM_METER', 'FAULTLINE_CLAIM_METER_LEDGER', 'FAULTLINE_KEY_IDEMPOTENCY_LEDGER'];
let saved: Record<string, string | undefined>;
let dir: string;
let ledger: string;

const supported = (claimId: string): CommittedClaim => ({ claimId, verdict: 'supported', provider: 'mock' });
const noCustomer = () => null;
const JUNE = new Date('2026-06-15T12:00:00Z');

function fileLines(): Array<Record<string, unknown>> {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}
const fileRows = (): UsageRecord[] => fileLines().filter((l) => l.kind !== 'header') as unknown as UsageRecord[];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-claim-store-'));
  ledger = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_CLAIM_METER_LEDGER = ledger;
  process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER = join(dir, 'key-idempotency.jsonl');
  process.env.FAULTLINE_CLAIM_METER = '1';
  resetClaimMeter();
  resetKeyStore();
});

afterEach(() => {
  setClaimMeterAppendForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetClaimMeter();
  resetKeyStore();
  rmSync(dir, { recursive: true, force: true });
});

describe('billable claims use the engine rule', () => {
  it('bills only engine-sourced verdicts: supported, contradicted, mixed with a source and an engine retriever', () => {
    const src = [{ title: 'S', uri: 'https://example.org/s' }];
    const engine = (provider?: string) => ({ ...(provider ? { provider } : {}), retriever: 'gemini-grounding' });
    const claims = billableClaims({
      verifications: {
        c1: { status: 'supported', sources: src, provenance: engine('gemini') },
        c2: { status: 'contradicted', sources: src, provenance: engine() },
        c3: { status: 'mixed', sources: src, provenance: engine() },
        c4: { status: 'unverified', sources: src, provenance: engine() },
        c5: { status: 'supported', sources: src, provenance: engine(), apiError: true },
        c6: { status: 'skipped', sources: src, provenance: engine() },
        c7: { status: 'ROYALLY_CERTIFIED', sources: src, provenance: engine() },
        c8: { status: 'supported', sources: [], provenance: engine() },
        c9: { status: 'supported', sources: src, provenance: { provider: 'mock' } },
        c10: { status: 'supported', sources: src },
      },
    }, 'gemini');
    expect(claims.length).toBeGreaterThan(0);
    expect(claims).toEqual([
      { claimId: 'c1', verdict: 'supported', provider: 'gemini' },
      { claimId: 'c2', verdict: 'contradicted', provider: 'gemini' },
      { claimId: 'c3', verdict: 'mixed', provider: 'gemini' },
    ]);
  });

  it('an unverified verdict is never billable, even sourced and engine-retrieved', () => {
    const verdict = { status: 'unverified', sources: [{ title: 'S', uri: 'https://example.org/s' }], provenance: { retriever: 'gemini-grounding' } };
    expect(billableClaims({ verifications: { c1: verdict } }, 'gemini')).toEqual([]);
    expect(BILLED_VERDICTS).toEqual(['supported', 'contradicted', 'mixed']);
  });

  it('the usage record refuses a row whose verdict is not billable', () => {
    const meter = new ClaimMeter();
    const added = meter.commitUsage('key-1', randomUUID(), [{ claimId: 'c1', verdict: 'unverified' as never, provider: 'gemini' }], null, JUNE);
    expect(added).toBe(0);
    expect(fileRows()).toEqual([]);
  });
});

describe('reserve, commit, release', () => {
  it('refuses when used + reserved + requested > cap, with the 402 numbers, period and resetsAt', () => {
    const meter = new ClaimMeter();
    const scan = randomUUID();
    const first = meter.reserve('k', 3, 5, noCustomer, JUNE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.reservation.commit(scan, [supported('c1'), supported('c2')], JUNE);
    first.reservation.release();
    expect(meter.reserve('k', 2, 5, noCustomer, JUNE).ok).toBe(true); // 2 used + 2 reserved
    // 2 used + 2 reserved + 2 requested = 6 > 5: refused whole, never part-served.
    expect(meter.reserve('k', 2, 5, noCustomer, JUNE)).toEqual({
      ok: false, cap: 5, used: 2, remaining: 1, period: '2026-06', resetsAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('periodResetsAt is the first instant of the next UTC month, December included', () => {
    expect(periodResetsAt(new Date('2026-12-31T23:59:59Z'))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('commits only what was given and releases the rest', () => {
    const meter = new ClaimMeter();
    const r = meter.reserve('k', 8, 10, noCustomer, JUNE);
    if (!r.ok) throw new Error('refused');
    expect(r.reservation.commit(randomUUID(), [supported('c1'), supported('c2'), supported('c3')], JUNE)).toBe(3);
    expect(meter.reservedFor('k')).toBe(5);
    r.reservation.release();
    expect(meter.reservedFor('k')).toBe(0);
    expect(meter.usageFor('k', '2026-06').used).toBe(3);
  });

  it('a new month starts from zero', () => {
    const meter = new ClaimMeter();
    const r = meter.reserve('k', 2, 2, noCustomer, JUNE);
    if (!r.ok) throw new Error('refused');
    r.reservation.commit(randomUUID(), [supported('c1'), supported('c2')], JUNE);
    r.reservation.release();
    expect(meter.reserve('k', 1, 2, noCustomer, JUNE).ok).toBe(false);
    expect(meter.reserve('k', 1, 2, noCustomer, new Date('2026-07-01T00:00:00Z')).ok).toBe(true);
  });
});

describe('the row', () => {
  it('has exactly the contract fields, no text, and identifier scanId:claimId', () => {
    const meter = new ClaimMeter();
    const scan = randomUUID();
    meter.commitUsage('key-1', scan, [{ claimId: 'c1', verdict: 'supported', provider: 'gemini' }], 'cus_ABC', JUNE);
    const rows = fileRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({
      seq: 1, ts: '2026-06-15T12:00:00.000Z', period: '2026-06', kind: 'usage', keyId: 'key-1',
      stripeCustomerId: 'cus_ABC', scanId: scan, claimId: 'c1', verdict: 'supported', provider: 'gemini',
      identifier: `${scan}:c1`,
    });
  });

  it('a claimId over 58 characters is refused and counted, and the log carries a count, not the id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const meter = new ClaimMeter();
    const scan = randomUUID();
    const long = 'x'.repeat(MAX_CLAIM_ID_LENGTH + 1);
    const atLimit = 'y'.repeat(MAX_CLAIM_ID_LENGTH);
    expect(meter.commitUsage('k', scan, [supported(long), supported(atLimit)], null, JUNE)).toBe(1);
    const rows = fileRows();
    expect(rows.length).toBe(1);
    expect(rows[0].claimId).toBe(atLimit);
    expect(rows[0].identifier.length).toBe(95);
    expect(meter.totals('2026-06').refusedIdentifiers).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(long);
    warn.mockRestore();
  });

  it('a scanId that is not a UUID is refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const meter = new ClaimMeter();
    expect(meter.commitUsage('k', 'scan-not-a-uuid', [supported('c1')], null, JUNE)).toBe(0);
    expect(fileRows()).toEqual([]);
    warn.mockRestore();
  });

  it('recordScanId strips the scan- prefix of an issued id; jobRecordScanId rebuilds a job id UUID', () => {
    const id = randomUUID();
    expect(recordScanId(`scan-${id}`)).toBe(id);
    expect(recordScanId(id)).toBe(id);
    const jobId = newJobId();
    const rebuilt = jobRecordScanId(jobId);
    expect(rebuilt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rebuilt.replace(/-/g, '')).toBe(jobId.slice(-32));
  });
});

describe('seq', () => {
  it('starts at 1, rises by one per row, and is never reused across a rebuilt store', () => {
    const a = new ClaimMeter();
    a.commitUsage('k', randomUUID(), [supported('c1'), supported('c2')], null, JUNE);
    const b = new ClaimMeter(); // a restart
    b.commitUsage('k', randomUUID(), [supported('c1')], null, JUNE);
    const seqs = fileRows().map((r) => r.seq);
    expect(seqs.length).toBe(3);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('concurrent commits from many async tasks get unique, gap-free seqs in file order', async () => {
    const meter = getClaimMeter();
    const tasks = Array.from({ length: 50 }, async (_, i) => {
      await new Promise((resolve) => setTimeout(resolve, i % 7));
      const r = meter.reserve(`k${i % 5}`, 2, 1_000, noCustomer);
      if (!r.ok) throw new Error('refused');
      await Promise.resolve();
      r.reservation.commit(randomUUID(), [supported('c1'), supported('c2')]);
      r.reservation.release();
    });
    await Promise.all(tasks);
    const seqs = fileRows().map((r) => r.seq);
    expect(seqs.length).toBe(100);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    const page = meter.page(0, 1000);
    expect(page.records.map((r) => r.seq)).toEqual(seqs);
  });

  it('a row whose write fails gets no seq; the next row continues from the last written seq', () => {
    const meter = new ClaimMeter();
    meter.commitUsage('k', randomUUID(), [supported('c1')], null, JUNE);
    setClaimMeterAppendForTests(() => { throw new Error('disk full'); });
    expect(meter.commitUsage('k', randomUUID(), [supported('c1')], null, JUNE)).toBe(1);
    expect(meter.getWriteFailures()).toBe(1);
    expect(meter.usageFor('k', '2026-06').used).toBe(2); // still counts against the cap here
    setClaimMeterAppendForTests(null);
    meter.commitUsage('k', randomUUID(), [supported('c1')], null, JUNE);
    expect(fileRows().map((r) => r.seq)).toEqual([1, 2]);
    expect(meter.page(0, 10).records.map((r) => r.seq)).toEqual([1, 2]);
  });
});

describe('duplicates and hydration', () => {
  it('a duplicate identifier is written once and counted once (one commit, two commits, across a restart)', () => {
    const scan = randomUUID();
    const a = new ClaimMeter();
    expect(a.commitUsage('k', scan, [supported('c1'), supported('c1')], null, JUNE)).toBe(1);
    expect(a.commitUsage('k', scan, [supported('c1')], null, JUNE)).toBe(0);
    const b = new ClaimMeter();
    expect(b.commitUsage('k', scan, [supported('c1')], null, JUNE)).toBe(0);
    expect(fileRows().length).toBe(1);
    expect(b.usageFor('k', '2026-06').used).toBe(1);
  });

  it('a rebuilt store keeps used counts, byVerdict, seq and ledgerId', () => {
    const a = new ClaimMeter();
    a.commitUsage('k', randomUUID(), [supported('c1'), { claimId: 'c2', verdict: 'contradicted', provider: 'mock' }], null, JUNE);
    const before = a.status('2026-06');
    expect(before.ledgerId).toMatch(/^[0-9a-f-]{36}$/);
    const b = new ClaimMeter();
    expect(b.usageFor('k', '2026-06')).toEqual({ used: 2, byVerdict: { supported: 1, contradicted: 1 } });
    expect(b.status('2026-06')).toEqual({ ledgerId: before.ledgerId, lastSeq: 2, rowsThisPeriod: 2 });
    b.commitUsage('k', randomUUID(), [supported('c1')], null, JUNE);
    expect(new ClaimMeter().status('2026-06').ledgerId).toBe(before.ledgerId);
    // The header is the first line, written once.
    const lines = fileLines();
    expect(lines.length).toBe(4);
    expect(lines[0]).toMatchObject({ kind: 'header', ledgerId: before.ledgerId, version: 1 });
    expect(lines.filter((l) => l.kind === 'header').length).toBe(1);
  });

  it('skips corrupt and partial lines and rows whose seq does not advance', () => {
    const scan = randomUUID();
    const row = (seq: number, claimId: string) => JSON.stringify({
      seq, ts: JUNE.toISOString(), period: '2026-06', kind: 'usage', keyId: 'k', stripeCustomerId: null,
      scanId: scan, claimId, verdict: 'supported', provider: 'mock', identifier: `${scan}:${claimId}`,
    });
    writeFileSync(ledger, [
      JSON.stringify({ kind: 'header', ledgerId: 'L1', version: 1, createdAt: JUNE.toISOString() }),
      row(1, 'c1'), '{"seq":2,"ts"', row(1, 'c9'), row(2, 'c2'), 'not json', '',
    ].join('\n'));
    const meter = new ClaimMeter();
    expect(meter.usageFor('k', '2026-06').used).toBe(2);
    expect(meter.status('2026-06')).toEqual({ ledgerId: 'L1', lastSeq: 2, rowsThisPeriod: 2 });
  });

  it('no ledger file: ledgerId null, nothing written by reads', () => {
    const meter = new ClaimMeter();
    expect(meter.page(0, 500)).toEqual({ ledgerId: null, records: [], nextAfter: 0, hasMore: false });
    expect(meter.status()).toEqual({ ledgerId: null, lastSeq: 0, rowsThisPeriod: 0 });
    expect(existsSync(ledger)).toBe(false);
  });
});

describe('voids', () => {
  it('cancel each usage row of a scan once, subtract from the cancelled row\'s period, and survive a restart', () => {
    const scan = randomUUID();
    const a = new ClaimMeter();
    a.commitUsage('k', scan, [supported('c1'), supported('c2')], 'cus_1', JUNE);
    const july = new Date('2026-07-02T00:00:00Z');
    expect(a.voidScan('k', scan, july)).toBe(2);
    expect(a.voidScan('k', scan, july)).toBe(0);
    expect(a.usageFor('k', '2026-06').used).toBe(0);
    const voids = fileRows().filter((r) => r.kind === 'void');
    expect(voids.length).toBe(2);
    expect(voids[0]).toEqual({
      seq: 3, ts: july.toISOString(), period: '2026-07', kind: 'void', keyId: 'k', stripeCustomerId: 'cus_1',
      scanId: scan, claimId: 'c1', verdict: 'supported', provider: 'mock',
      identifier: voidIdentifier(claimIdentifier(scan, 'c1')), voids: claimIdentifier(scan, 'c1'),
    });
    const b = new ClaimMeter();
    expect(b.usageFor('k', '2026-06').used).toBe(0);
    expect(b.voidScan('k', scan, july)).toBe(0);
  });

  it('void rows are not usage: they never add to used', () => {
    const scan = randomUUID();
    const meter = new ClaimMeter();
    meter.commitUsage('k', scan, [supported('c1'), supported('c2'), supported('c3')], null, JUNE);
    meter.voidScan('k', scan, JUNE);
    expect(meter.usageFor('k', '2026-06').used).toBe(0);
    expect(meter.totals('2026-06').used).toBe(0);
    expect(new ClaimMeter().usageFor('k', '2026-06').used).toBe(0);
  });

  it('only voids the given key\'s rows', () => {
    const scan = randomUUID();
    const meter = new ClaimMeter();
    meter.commitUsage('owner', scan, [supported('c1')], null, JUNE);
    expect(meter.voidScan('someone-else', scan, JUNE)).toBe(0);
    expect(meter.usageFor('owner', '2026-06').used).toBe(1);
  });
});

describe('paging', () => {
  it('after/limit, nextAfter and hasMore walk the record in seq order', () => {
    const meter = new ClaimMeter();
    for (let i = 0; i < 5; i++) meter.commitUsage('k', randomUUID(), [supported('c1')], null, JUNE);
    const p1 = meter.page(0, 2);
    expect(p1.records.length).toBe(2);
    expect(p1.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(p1).toMatchObject({ nextAfter: 2, hasMore: true });
    const p2 = meter.page(p1.nextAfter, 2);
    expect(p2.records.map((r) => r.seq)).toEqual([3, 4]);
    const p3 = meter.page(p2.nextAfter, 2);
    expect(p3.records.map((r) => r.seq)).toEqual([5]);
    expect(p3).toMatchObject({ nextAfter: 5, hasMore: false });
    expect(meter.page(5, 2)).toMatchObject({ records: [], nextAfter: 5, hasMore: false });
  });
});

describe('who is metered (reserveClaimsFor)', () => {
  it('meter off: nothing is metered, a metered key included', () => {
    delete process.env.FAULTLINE_CLAIM_METER;
    const key = getKeyStore().create('m', ['scan'], undefined, { metered: true, claimCap: 0 });
    expect(reserveClaimsFor(key.id, 8)).toEqual({ ok: true });
  });

  it('meter on: an unmetered key, the server key and an admin key are not metered', () => {
    const plain = getKeyStore().create('plain', ['scan'], undefined, { claimCap: 0 });
    const admin = getKeyStore().create('admin', ['admin'], undefined, { metered: true, claimCap: 0 });
    expect(reserveClaimsFor(plain.id, 8)).toEqual({ ok: true });
    expect(reserveClaimsFor('admin', 8)).toEqual({ ok: true });
    expect(reserveClaimsFor(admin.id, 8)).toEqual({ ok: true });
    expect(reserveClaimsFor(undefined, 8)).toEqual({ ok: true });
  });

  it('a metered key with no claimCap is refused with claim_cap_unset', () => {
    const key = getKeyStore().create('m', ['scan'], undefined, { metered: true });
    expect(reserveClaimsFor(key.id, 1)).toEqual({ ok: false, statusCode: 402, body: { error: 'claim_cap_unset' } });
  });

  it('a disabled or deleted metered key gets no new reservation; its committed rows stay', () => {
    const key = getKeyStore().create('m', ['scan'], undefined, { metered: true, claimCap: 10 });
    const r = reserveClaimsFor(key.id, 1);
    if (!r.ok || !r.reservation) throw new Error('not reserved');
    r.reservation.commit(randomUUID(), [supported('c1')]);
    getKeyStore().disable(key.id);
    expect(reserveClaimsFor(key.id, 1)).toEqual({ ok: false, statusCode: 403, body: { error: 'key_revoked' } });
    getKeyStore().delete(key.id);
    expect(reserveClaimsFor(key.id, 1)).toEqual({ ok: false, statusCode: 403, body: { error: 'key_revoked' } });
    expect(getClaimMeter().usageFor(key.id).used).toBe(1);
  });
});

describe('stripeCustomerId is copied at commit time', () => {
  it('rebinding the key after a commit leaves the earlier row unchanged', () => {
    const key = getKeyStore().create('m', ['scan'], undefined, { metered: true, claimCap: 10, stripeCustomerId: 'cus_OLD' });
    const r = reserveClaimsFor(key.id, 2);
    if (!r.ok || !r.reservation) throw new Error('not reserved');
    r.reservation.commit(randomUUID(), [supported('c1')]);
    getKeyStore().update(key.id, { stripeCustomerId: 'cus_NEW' });
    // The same reservation commits again after the rebind: the new row gets the new customer.
    r.reservation.commit(randomUUID(), [supported('c1')]);
    const rows = fileRows();
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.stripeCustomerId)).toEqual(['cus_OLD', 'cus_NEW']);
    expect(getClaimMeter().page(0, 10).records[0].stripeCustomerId).toBe('cus_OLD');
  });

  it('a metered key with no stripeCustomerId runs and its rows carry null', () => {
    const key = getKeyStore().create('m', ['scan'], undefined, { metered: true, claimCap: 10 });
    const r = reserveClaimsFor(key.id, 1);
    if (!r.ok || !r.reservation) throw new Error('not reserved');
    r.reservation.commit(randomUUID(), [supported('c1')]);
    const rows = fileRows();
    expect(rows.length).toBe(1);
    expect(rows[0].stripeCustomerId).toBeNull();
  });
});

describe('meteredScan (work outside a request)', () => {
  it('refuses before running when the key is over its cap', async () => {
    const key = getKeyStore().create('m', ['scan'], undefined, { metered: true, claimCap: 0 });
    const run = vi.fn(async () => ({ verifications: {} }));
    await expect(meteredScan(key.id, 8, randomUUID(), 'mock', run)).rejects.toBeInstanceOf(ClaimMeterRefusedError);
    expect(run).not.toHaveBeenCalled();
  });

  it('commits the verdicts and releases the rest; an error commits nothing and releases', async () => {
    const key = getKeyStore().create('m', ['scan'], undefined, { metered: true, claimCap: 100 });
    const engineVerdict = { status: 'supported', sources: [{ title: 'S', uri: 'https://example.org/s' }], provenance: { provider: 'gemini', retriever: 'gemini-grounding' } };
    await meteredScan(key.id, 8, randomUUID(), 'gemini', async () => ({ verifications: { c1: engineVerdict, c2: { ...engineVerdict, status: 'unverified' } } }));
    expect(getClaimMeter().usageFor(key.id).used).toBe(1);
    await expect(meteredScan(key.id, 8, randomUUID(), 'mock', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(getClaimMeter().usageFor(key.id).used).toBe(1);
    expect(getClaimMeter().reservedFor(key.id)).toBe(0);
  });
});
