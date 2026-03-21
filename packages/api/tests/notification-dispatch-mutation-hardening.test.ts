/**
 * N-130 — NotificationStore dispatch + convenience dispatchers mutation hardening (ND1–ND15)
 *
 * Targets the 20 surviving mutants in notifications.ts not killed by N-126/N-128/N-129:
 *
 * _deliver() fetch internals (lines 196–207):
 *   ND1: fetch returns 200 → delivered=true, error=null (kills if(true) at line 204)
 *   ND2: fetch returns 503 → delivered=false, error='HTTP 503' (kills if(false) + if(res.ok))
 *   ND3: fetch throws Error → error = thrown message (kills catch BlockStatement removal line 205)
 *   ND4: fetch called with method='POST' + Content-Type header (kills lines 199–200 mutations)
 *   ND5: fetch body is valid JSON containing event, keyId, and payload fields (kills line 201 body:{})
 *   ND6: no webhookUrl → error='no-webhook-configured' (kills if(webhookUrl) BlockStatement line 196)
 *
 * Convenience dispatcher payloads (lines 235, 240, 244):
 *   ND7: notifyScanFailed — history record payload contains error + provider (kills line 235 {})
 *   ND8: notifyProviderStatus(provider, false) — payload has available:false (kills line 240 {})
 *   ND9: notifyProviderStatus(provider, true) — payload has available:true + provider field
 *   ND10: notifySubscriptionChanged — history record payload has the change fields (kills line 244 {})
 *
 * deleteTenantHistory filter (line 135):
 *   ND11: deleteTenantHistory returns 0 for non-matching records, preserves them (kills (r)=>false)
 *
 * EVENT_CATALOGUE 'key.rotation_due' entry (line 58):
 *   ND12: description is non-empty string (kills description:"" mutation)
 *   ND13: example object has keyId and keyName properties (kills example:{} mutation)
 *   ND14: example.keyId is a non-empty string (kills keyId:"" mutation)
 *   ND15: example.keyName is a non-empty string (kills keyName:"" mutation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getNotificationStore,
  resetNotificationStore,
  notifyScanFailed,
  notifyProviderStatus,
  notifySubscriptionChanged,
  EVENT_CATALOGUE,
} from '../src/store/notifications.js';

// Helper: set prefs with a webhook URL so _deliver() fires fetch
function stubFetch(response: { ok: boolean; status: number }) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

// ── _deliver() response status handling (ND1–ND3) ────────────────────────────

describe('NotificationStore._deliver() — HTTP response handling', () => {
  beforeEach(() => {
    resetNotificationStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ND1: fetch returns 200 OK → delivered=true, error=null
  // Kills: `if (true)` at line 204 which would always set error on success
  // Kills: `if (res.ok)` at line 204 which inverts the error condition
  it('ND1: fetch 200 → delivered=true, error=null in delivery record', async () => {
    stubFetch({ ok: true, status: 200 });
    const store = getNotificationStore();
    store.setPrefs('key-ok', ['scan.failed'], 'http://wh.example.com/ok', null);
    await store.dispatch('scan.failed', { msg: 'test' }, 'key-ok');

    const [rec] = store.getHistory();
    expect(rec.delivered).toBe(true);
    expect(rec.error).toBeNull();
  });

  // ND2: fetch returns 503 → delivered=false, error='HTTP 503'
  // Kills: `if (false)` at line 204 (never sets error → error stays null)
  // Kills: `if (res.ok)` at line 204 (records error on success, not on failure)
  it('ND2: fetch 503 → delivered=false, error="HTTP 503" in delivery record', async () => {
    stubFetch({ ok: false, status: 503 });
    const store = getNotificationStore();
    store.setPrefs('key-err', ['scan.failed'], 'http://wh.example.com/fail', null);
    await store.dispatch('scan.failed', { msg: 'error' }, 'key-err');

    const [rec] = store.getHistory();
    expect(rec.delivered).toBe(false);
    expect(rec.error).toBe('HTTP 503');
  });

  // ND3: fetch throws → error = thrown message (kills catch BlockStatement removal at line 205)
  // With BlockStatement removal: catch body is empty, record.error stays null
  it('ND3: fetch throws → error captured from thrown exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const store = getNotificationStore();
    store.setPrefs('key-throw', ['scan.failed'], 'http://unreachable.example.com', null);
    await store.dispatch('scan.failed', { msg: 'throw' }, 'key-throw');

    const [rec] = store.getHistory();
    expect(rec.delivered).toBe(false);
    expect(rec.error).toBe('ECONNREFUSED');
  });
});

// ── _deliver() fetch call arguments (ND4–ND6) ─────────────────────────────────

describe('NotificationStore._deliver() — fetch call arguments', () => {
  beforeEach(() => {
    resetNotificationStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ND4: fetch called with method='POST' and Content-Type application/json
  // Kills: `method: ""` mutation at line 199
  // Kills: `headers: {}` mutation at line 200
  // Kills: `headers: { 'Content-Type': "" }` mutation at line 200
  it('ND4: fetch is called with method="POST" and Content-Type: application/json', async () => {
    stubFetch({ ok: true, status: 200 });
    const store = getNotificationStore();
    store.setPrefs('key-args', ['scan.failed'], 'http://args.example.com', null);
    await store.dispatch('scan.failed', { claimId: 'c1' }, 'key-args');

    const mockFetch = vi.mocked(fetch);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [_url, options] = mockFetch.mock.calls[0];
    expect((options as RequestInit).method).toBe('POST');
    expect((options as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/json',
    });
  });

  // ND5: fetch body is valid JSON containing the event type, keyId, and payload fields
  // Kills: `body: JSON.stringify({})` mutation at line 201
  it('ND5: fetch body contains event, keyId, and payload fields', async () => {
    stubFetch({ ok: true, status: 200 });
    const store = getNotificationStore();
    store.setPrefs('key-body', ['scan.failed'], 'http://body.example.com', null);
    await store.dispatch('scan.failed', { errorDetails: 'timeout' }, 'key-body');

    const mockFetch = vi.mocked(fetch);
    const [_url, options] = mockFetch.mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.event).toBe('scan.failed');
    expect(body.keyId).toBe('key-body');
    expect(body.errorDetails).toBe('timeout'); // payload field spread into body
  });

  // ND6: no webhookUrl in prefs, no global fallback → error='no-webhook-configured'
  // Kills: `if (webhookUrl)` BlockStatement removal at line 196
  //   With removal, fetch(null) would throw → error would be a TypeError, not 'no-webhook-configured'
  it('ND6: null webhook URL produces error="no-webhook-configured" in delivery record', async () => {
    const store = getNotificationStore();
    store.setPrefs('key-nowh', ['scan.failed'], null, null);
    delete process.env.FAULTLINE_NOTIFY_WEBHOOK;
    await store.dispatch('scan.failed', { msg: 'no wh' }, 'key-nowh');

    const [rec] = store.getHistory();
    expect(rec.delivered).toBe(false);
    expect(rec.error).toBe('no-webhook-configured');
    // fetch must NOT have been called (the if(webhookUrl) check should gate it)
    // If the block is removed, fetch would be called with null and would throw
  });
});

// ── Convenience dispatcher payloads (ND7–ND10) ───────────────────────────────

describe('Convenience dispatchers — payload field assertions', () => {
  beforeEach(() => {
    resetNotificationStore();
    vi.clearAllMocks();
    delete process.env.FAULTLINE_NOTIFY_WEBHOOK;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ND7: notifyScanFailed — history record payload must contain error + provider
  // Kills: `{ keyId, error, provider }` → `{}` at line 235
  it('ND7: notifyScanFailed payload includes error and provider in history record', async () => {
    getNotificationStore().setPrefs('key-sf', ['scan.failed'], null, null);
    await notifyScanFailed('key-sf', 'timeout error', 'openai');

    const recs = getNotificationStore().getHistory('key-sf');
    expect(recs.length).toBe(1);
    expect(recs[0].payload).toMatchObject({
      error: 'timeout error',
      provider: 'openai',
    });
  });

  // ND8: notifyProviderStatus(provider, false) — payload has available:false
  // Kills: `{ provider, available, timestamp }` → `{}` at line 240
  // Uses global webhook fallback (hasFallback path) to generate a history record
  it('ND8: notifyProviderStatus(provider, false) payload includes available:false', async () => {
    process.env.FAULTLINE_NOTIFY_WEBHOOK = 'http://global.example.com/wh';
    stubFetch({ ok: true, status: 200 });
    await notifyProviderStatus('gemini', false);

    const recs = getNotificationStore().getHistory();
    const rec = recs.find(r => r.eventType === 'provider.unavailable');
    expect(rec).toBeDefined();
    expect(rec!.payload.available).toBe(false);
    expect(rec!.payload.provider).toBe('gemini');
  });

  // ND9: notifyProviderStatus(provider, true) — payload has available:true + timestamp
  // Kills ObjectLiteral `{}` mutation at line 240 (timestamp field must be present)
  it('ND9: notifyProviderStatus(provider, true) payload includes available:true and timestamp', async () => {
    process.env.FAULTLINE_NOTIFY_WEBHOOK = 'http://global.example.com/wh';
    stubFetch({ ok: true, status: 200 });
    await notifyProviderStatus('gemini', true);

    const recs = getNotificationStore().getHistory();
    const rec = recs.find(r => r.eventType === 'provider.available');
    expect(rec).toBeDefined();
    expect(rec!.payload.available).toBe(true);
    expect(rec!.payload.provider).toBe('gemini');
    // timestamp must be present and non-empty (kills timestamp: undefined from ObjectLiteral mutation)
    expect(typeof rec!.payload.timestamp).toBe('string');
    expect((rec!.payload.timestamp as string).length).toBeGreaterThan(0);
  });

  // ND10: notifySubscriptionChanged — payload must contain the change object's fields
  // Kills: `{ keyId, ...change }` → `{}` at line 244
  it('ND10: notifySubscriptionChanged payload includes change fields in history record', async () => {
    getNotificationStore().setPrefs('key-sub', ['subscription.changed'], null, null);
    await notifySubscriptionChanged('key-sub', { plan: 'pro', seats: 5 });

    const recs = getNotificationStore().getHistory('key-sub');
    expect(recs.length).toBe(1);
    expect(recs[0].payload).toMatchObject({ plan: 'pro', seats: 5 });
  });
});

// ── deleteTenantHistory filter (ND11) ─────────────────────────────────────────

describe('NotificationStore.deleteTenantHistory() — filter correctness', () => {
  beforeEach(() => {
    resetNotificationStore();
    delete process.env.FAULTLINE_NOTIFY_WEBHOOK;
  });

  // ND11: deleteTenantHistory for a non-matching tenantId returns 0 and preserves records
  // Kills: `(r) => r.tenantId !== tenantId` → `(r) => false` at line 135
  //   With (r)=>false: ALL records deleted → returns >0, getHistory() returns [] → test fails → kills mutant
  it('ND11: deleteTenantHistory for non-matching tenantId preserves all records', async () => {
    const store = getNotificationStore();
    // Dispatch to a key with no tenant association (tenantId will be undefined)
    store.setPrefs('key-notenant', ['scan.failed'], null, null);
    await store.dispatch('scan.failed', { msg: 'x' }, 'key-notenant');
    expect(store.getHistory().length).toBe(1);

    // Delete for a tenantId that no record belongs to
    const deleted = store.deleteTenantHistory('tenant-that-does-not-exist');
    expect(deleted).toBe(0);
    // Record must be preserved (not removed by filter=>false mutant)
    expect(store.getHistory().length).toBe(1);
  });
});

// ── EVENT_CATALOGUE 'key.rotation_due' content (ND12–ND15) ───────────────────

describe('EVENT_CATALOGUE — key.rotation_due entry completeness', () => {
  // ND12: description is a non-empty string
  // Kills: `description: ""` StringLiteral mutation at line 58
  it('ND12: key.rotation_due description is non-empty', () => {
    const entry = EVENT_CATALOGUE['key.rotation_due'];
    expect(entry.description.length).toBeGreaterThan(0);
    expect(entry.description).not.toBe('');
  });

  // ND13: example object has both keyId and keyName properties
  // Kills: `example: {}` ObjectLiteral mutation at line 58
  it('ND13: key.rotation_due example has keyId and keyName properties', () => {
    const { example } = EVENT_CATALOGUE['key.rotation_due'];
    expect(example).toHaveProperty('keyId');
    expect(example).toHaveProperty('keyName');
  });

  // ND14: example.keyId is a non-empty string
  // Kills: `keyId: ""` StringLiteral mutation at line 58
  it('ND14: key.rotation_due example.keyId is non-empty', () => {
    const { example } = EVENT_CATALOGUE['key.rotation_due'];
    expect(typeof example.keyId).toBe('string');
    expect((example.keyId as string).length).toBeGreaterThan(0);
  });

  // ND15: example.keyName is a non-empty string
  // Kills: `keyName: ""` StringLiteral mutation at line 58
  it('ND15: key.rotation_due example.keyName is non-empty', () => {
    const { example } = EVENT_CATALOGUE['key.rotation_due'];
    expect(typeof example.keyName).toBe('string');
    expect((example.keyName as string).length).toBeGreaterThan(0);
  });
});
