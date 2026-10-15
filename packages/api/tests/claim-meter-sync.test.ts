// Validates: node 1.18.11.7.6 (claim meter -> Stripe Billing meter events; no network: fetch is injected)
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getClaimMeter, resetClaimMeter } from '../src/store/claim-meter.js';
import {
  STRIPE_METER_EVENTS_URL,
  StripeMeterSink,
  getStripeMeterSink,
  meterEventForm,
  resetStripeMeterSink,
  startClaimMeterSync,
  stopClaimMeterSync,
} from '../src/store/claim-meter-sync.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';

const ENV_KEYS = ['FAULTLINE_CLAIM_METER_LEDGER', 'FAULTLINE_CLAIM_METER_SYNC_LEDGER', 'STRIPE_SECRET_KEY', 'FAULTLINE_STRIPE_METER_EVENT'];
let saved: Record<string, string | undefined>;
let dir: string;

beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-claim-sync-'));
  process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_CLAIM_METER_SYNC_LEDGER = join(dir, 'claim-meter-sync.jsonl');
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.FAULTLINE_STRIPE_METER_EVENT;
  resetClaimMeter();
  resetStripeMeterSink();
  resetKeyStore();
});

afterEach(() => {
  resetStripeMeterSink();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetClaimMeter();
  rmSync(dir, { recursive: true, force: true });
});

interface Sent { url: string; headers: Record<string, string>; form: URLSearchParams }

/** A fetch that answers from a script of status codes (or 'throw'), recording every request. */
function fakeFetch(script: Array<number | 'throw'> = []) {
  const sent: Sent[] = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    sent.push({ url, headers: init.headers, form: new URLSearchParams(init.body) });
    const next = script.length > 0 ? script.shift()! : 200;
    if (next === 'throw') throw new Error('socket hang up');
    return { status: next, text: async () => JSON.stringify({ error: { message: `status ${next}` } }) };
  };
  return { fn, sent };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };

function seed(keyId: string, scanId: string, claimIds: string[], ts = new Date('2026-10-15T12:00:00Z')) {
  getClaimMeter().append(keyId, '2026-10', scanId, claimIds.map((claimId) => ({ claimId, verdict: 'supported', provider: 'mock' })), ts);
}

function sink(fetch: ReturnType<typeof fakeFetch>['fn'], extra: Partial<ConstructorParameters<typeof StripeMeterSink>[0]> = {}) {
  sleeps.length = 0;
  return new StripeMeterSink({
    fetch, sleep, secretKey: 'sk_test_fake', eventName: 'faultline_claims', baseDelayMs: 100,
    now: () => new Date('2026-10-15T12:05:00Z'), ...extra,
  });
}

describe('meter event body', () => {
  it('is the Stripe form: event_name, timestamp, identifier, customer, value=1', () => {
    const [row] = (seed('k1', 'scan-1', ['c1']), getClaimMeter().unsentRows());
    const form = meterEventForm(row, 'cus_ABC', 'faultline_claims');
    expect(Object.fromEntries(form)).toEqual({
      event_name: 'faultline_claims',
      timestamp: String(Date.parse('2026-10-15T12:00:00Z') / 1000),
      identifier: 'scan-1:c1',
      'payload[stripe_customer_id]': 'cus_ABC',
      'payload[value]': '1',
    });
  });
});

describe('flush', () => {
  it('posts one event per unsent row to the meter_events endpoint and marks each sent, durably', async () => {
    const key = getKeyStore().create('c', ['scan'], undefined, { stripeCustomerId: 'cus_ABC' });
    seed(key.id, 'scan-1', ['c1', 'c2']);
    const f = fakeFetch();
    const report = await sink(f.fn).flush();
    expect(report).toEqual({ sent: 2, rejected: 0, waiting: 0, stoppedOnError: false });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0].url).toBe(STRIPE_METER_EVENTS_URL);
    expect(f.sent[0].url).toBe('https://api.stripe.com/v1/billing/meter_events');
    expect(f.sent[0].headers).toMatchObject({
      Authorization: 'Bearer sk_test_fake',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': 'claim-meter-scan-1:c1',
    });
    expect(f.sent.map((s) => s.form.get('identifier'))).toEqual(['scan-1:c1', 'scan-1:c2']);
    expect(getClaimMeter().lag().meterSyncLagRows).toBe(0);

    // Sent markers survive a restart: nothing is resent.
    resetClaimMeter();
    const again = fakeFetch();
    expect((await sink(again.fn).flush()).sent).toBe(0);
    expect(again.sent).toHaveLength(0);
    const markers = readFileSync(process.env.FAULTLINE_CLAIM_METER_SYNC_LEDGER as string, 'utf8').split('\n').filter(Boolean);
    expect(markers.map((m) => JSON.parse(m).identifier)).toEqual(['scan-1:c1', 'scan-1:c2']);
  });

  it('retries 5xx, 429 and network errors with backoff, resending the same identifier and Idempotency-Key', async () => {
    const key = getKeyStore().create('c', ['scan'], undefined, { stripeCustomerId: 'cus_ABC' });
    seed(key.id, 'scan-1', ['c1']);
    const f = fakeFetch([503, 'throw', 429, 200]);
    const report = await sink(f.fn).flush();
    expect(report.sent).toBe(1);
    expect(f.sent).toHaveLength(4);
    expect(new Set(f.sent.map((s) => s.form.get('identifier')))).toEqual(new Set(['scan-1:c1']));
    expect(new Set(f.sent.map((s) => s.headers['Idempotency-Key']))).toEqual(new Set(['claim-meter-scan-1:c1']));
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('stops the pass when a row still fails after every retry (an outage), leaving the rest unsent', async () => {
    const key = getKeyStore().create('c', ['scan'], undefined, { stripeCustomerId: 'cus_ABC' });
    seed(key.id, 'scan-1', ['c1', 'c2']);
    const f = fakeFetch([500, 500, 500, 500]);
    const s = sink(f.fn);
    const report = await s.flush();
    expect(report).toEqual({ sent: 0, rejected: 0, waiting: 2, stoppedOnError: true });
    expect(f.sent).toHaveLength(4);
    expect(getClaimMeter().lag().meterSyncLagRows).toBe(2);
    expect(s.getStatus().lastError).toContain('stripe 500');
  });

  it('a 4xx rejection leaves that row unsent and moves on without retrying it', async () => {
    const key = getKeyStore().create('c', ['scan'], undefined, { stripeCustomerId: 'cus_ABC' });
    seed(key.id, 'scan-1', ['c1', 'c2']);
    const f = fakeFetch([400, 200]);
    const report = await sink(f.fn).flush();
    expect(report).toEqual({ sent: 1, rejected: 1, waiting: 1, stoppedOnError: false });
    expect(getClaimMeter().unsentRows().map((r) => r.identifier)).toEqual(['scan-1:c1']);
  });

  it('rows of a key with no stripeCustomerId wait; they are sent once the id is set', async () => {
    const key = getKeyStore().create('c', ['scan']);
    seed(key.id, 'scan-1', ['c1']);
    const f = fakeFetch();
    expect(await sink(f.fn).flush()).toEqual({ sent: 0, rejected: 0, waiting: 1, stoppedOnError: false });
    expect(f.sent).toHaveLength(0);
    getKeyStore().update(key.id, { stripeCustomerId: 'cus_LATE' });
    expect((await sink(f.fn).flush()).sent).toBe(1);
    expect(f.sent[0].form.get('payload[stripe_customer_id]')).toBe('cus_LATE');
  });

  it('is off, sends nothing and calls no fetch, when STRIPE_SECRET_KEY or the event name is unset', async () => {
    const key = getKeyStore().create('c', ['scan'], undefined, { stripeCustomerId: 'cus_ABC' });
    seed(key.id, 'scan-1', ['c1']);
    const f = fakeFetch();
    for (const s of [sink(f.fn, { secretKey: null }), sink(f.fn, { eventName: null }), new StripeMeterSink({ fetch: f.fn })]) {
      expect(s.enabled()).toBe(false);
      expect(await s.flush()).toEqual({ sent: 0, rejected: 0, waiting: 1, stoppedOnError: false });
    }
    expect(f.sent).toHaveLength(0);
    expect(getClaimMeter().lag().meterSyncLagRows).toBe(1);
  });

  it('reads the secret and the event name from env', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_env';
    process.env.FAULTLINE_STRIPE_METER_EVENT = 'faultline_claims';
    const f = fakeFetch();
    const s = new StripeMeterSink({ fetch: f.fn });
    expect(s.enabled()).toBe(true);
    expect(s.getStatus()).toMatchObject({ enabled: true, eventName: 'faultline_claims' });
  });

  it('overlapping flushes share one pass (no double send)', async () => {
    const key = getKeyStore().create('c', ['scan'], undefined, { stripeCustomerId: 'cus_ABC' });
    seed(key.id, 'scan-1', ['c1']);
    const f = fakeFetch();
    const s = sink(f.fn);
    const [a, b] = await Promise.all([s.flush(), s.flush()]);
    expect(a).toBe(b);
    expect(f.sent).toHaveLength(1);
  });
});

describe('the sync loop', () => {
  it('does not start while the sink is off, and needs no network to stay off', () => {
    startClaimMeterSync();
    expect(getStripeMeterSink().enabled()).toBe(false);
    stopClaimMeterSync();
    expect(existsSync(process.env.FAULTLINE_CLAIM_METER_SYNC_LEDGER as string)).toBe(false);
  });
});
