/**
 * Scan history is scoped per API key; server-side HTML escapes user input.
 *
 * Access-control rule under test: a non-admin caller only reads, prunes or
 * deletes scan-history entries whose keyId equals its own request.keyId. The
 * admin key (FAULTLINE_API_KEY → keyId 'admin', or a keystore key holding the
 * 'admin' permission) keeps fleet-wide reads. A caller-supplied tenantId can only
 * narrow within the caller's own entries.
 *
 * Stored XSS under test: GET /scans/stale/view interpolated textPreview (raw scan
 * input) into HTML unescaped; GET /keys/usage/view did the same with key names.
 *
 * SHS1–SHS9    store: every read method honours the keyId scope; prune is key-scoped
 * SHR1–SHR14   routes: every requireApiKey scan-history reader, key A vs key B vs admin
 * SHX1–SHX4    HTML escaping on /scans/stale/view and /keys/usage/view
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { getScanHistory, resetScanHistory, hashText } from '../src/store/scan-history.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getTenantStore, resetTenantStore } from '../src/store/tenants.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';

const ADMIN_KEY = 'admin-key-scan-history-scope';
const DAY_MS = 86_400_000;

// Distinct, greppable markers per key. Each key's text is unique so a leak shows
// up as the other key's marker in the response body.
const TEXT_A = 'ALPHA-PRIVATE quarterly revenue claims for tenant A';
const TEXT_B = 'BRAVO-PRIVATE clinical trial claims for tenant B';
const SHARED_TEXT = 'SHARED identical document scanned by both keys';
const XSS_TEXT = '<script>alert(1)</script> injected preview "quoted"';

interface SeedOptions {
  keyId: string;
  text: string;
  provider?: string;
  daysAgo?: number;
  tenantId?: string;
}

function seed(opts: SeedOptions): void {
  getScanHistory().record({
    textHash:    hashText(opts.text),
    textPreview: opts.text.slice(0, 100),
    provider:    opts.provider ?? 'mock',
    overallRisk: 'Low',
    claimCount:  2,
    latencyMs:   50,
    timestamp:   new Date(Date.now() - (opts.daysAgo ?? 0) * DAY_MS).toISOString(),
    keyId:       opts.keyId,
    tenantId:    opts.tenantId,
  });
}

function resetAll(): void {
  resetKeyStore();
  resetTenantStore();
  resetScanHistory();
  resetAuditLogger();
  resetAnalytics();
  resetCache();
  resetCircuitBreaker();
}

// ── Store-level scope ─────────────────────────────────────────────────────────

describe('ScanHistoryStore — keyId scope', () => {
  beforeEach(() => {
    resetScanHistory();
    seed({ keyId: 'key-a', text: TEXT_A, daysAgo: 40, tenantId: 'tenant-a' });
    seed({ keyId: 'key-b', text: TEXT_B, daysAgo: 40, tenantId: 'tenant-b' });
  });

  it('SHS1: getRecent(limit, keyId) returns only that key\'s entries', () => {
    const recent = getScanHistory().getRecent(10, 'key-a');
    expect(recent).toHaveLength(1);
    expect(recent[0].keyId).toBe('key-a');
  });

  it('SHS2: getRecent filters before the limit (a full page of B does not hide A)', () => {
    for (let i = 0; i < 5; i++) seed({ keyId: 'key-b', text: `${TEXT_B} ${i}` });
    const recent = getScanHistory().getRecent(2, 'key-a');
    expect(recent).toHaveLength(1);
    expect(recent[0].textPreview).toBe(TEXT_A);
  });

  it('SHS3: getRecent without keyId stays fleet-wide (admin path unchanged)', () => {
    expect(getScanHistory().getRecent(10)).toHaveLength(2);
  });

  it('SHS4: getTimeline(hash, limit, keyId) excludes another key\'s scans of the same text', () => {
    seed({ keyId: 'key-a', text: SHARED_TEXT });
    seed({ keyId: 'key-b', text: SHARED_TEXT });
    seed({ keyId: 'key-b', text: SHARED_TEXT });
    const hash = hashText(SHARED_TEXT);
    expect(getScanHistory().getTimeline(hash, 50, 'key-a')).toHaveLength(1);
    expect(getScanHistory().getTimeline(hash, 50, 'key-b')).toHaveLength(2);
    expect(getScanHistory().getTimeline(hash, 50)).toHaveLength(3);
  });

  it('SHS5: getScanUsageStats(days, tenantId, keyId) — a foreign tenantId cannot widen past the key', () => {
    expect(getScanHistory().getScanUsageStats(30, undefined, 'key-a').map((s) => s.textPreview)).toEqual([TEXT_A]);
    expect(getScanHistory().getScanUsageStats(30, 'tenant-b', 'key-a')).toEqual([]);
    expect(getScanHistory().getScanUsageStats(30, 'tenant-a', 'key-a')).toHaveLength(1);
  });

  it('SHS6: getStaleScanGroups(days, tenantId, keyId) — key scope AND tenant filter', () => {
    expect(getScanHistory().getStaleScanGroups(30, undefined, 'key-b').map((e) => e.keyId)).toEqual(['key-b']);
    expect(getScanHistory().getStaleScanGroups(30, 'tenant-a', 'key-b')).toEqual([]);
  });

  it('SHS7: search({ keyId }) — q, tenantId and cursor stay inside the key scope', () => {
    const store = getScanHistory();
    expect(store.search({ keyId: 'key-b', q: 'ALPHA' }).entries).toEqual([]);
    expect(store.search({ keyId: 'key-b', tenantId: 'tenant-a' }).entries).toEqual([]);
    const own = store.search({ keyId: 'key-a' }).entries;
    expect(own).toHaveLength(1);
    expect(own[0].textPreview).toBe(TEXT_A);
  });

  it('SHS8: pruneStaleGroups(days, keyId) deletes only that key\'s entries for a shared hash', () => {
    seed({ keyId: 'key-a', text: SHARED_TEXT, daysAgo: 40 });
    seed({ keyId: 'key-b', text: SHARED_TEXT, daysAgo: 40 });
    const result = getScanHistory().pruneStaleGroups(30, 'key-a');
    expect(result.deletedEntries).toBe(2); // TEXT_A + key-a's SHARED_TEXT
    const remaining = getScanHistory().getRecent(100);
    expect(remaining.length).toBe(2);
    expect(remaining.every((e) => e.keyId === 'key-b')).toBe(true);
  });

  it('SHS9: pruneStaleGroups(days) without keyId stays fleet-wide (admin route)', () => {
    const result = getScanHistory().pruneStaleGroups(30);
    expect(result.deletedEntries).toBe(2);
    expect(getScanHistory().size).toBe(0);
  });
});

// ── Route-level scope ─────────────────────────────────────────────────────────

describe('scan-history readers — per-key isolation over HTTP', () => {
  let server: FastifyInstance;
  let keyA: { id: string; key: string };
  let keyB: { id: string; key: string };
  let tenantAId: string;

  const as = (key: string): Record<string, string> => ({ 'x-api-key': key });

  async function get(url: string, key: string): Promise<{ status: number; body: string }> {
    const res = await server.inject({ method: 'GET', url, headers: as(key) });
    return { status: res.statusCode, body: res.body };
  }

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = ADMIN_KEY;
    resetAll();
    keyA = getKeyStore().create('Key A', ['scan']);
    keyB = getKeyStore().create('Key B', ['scan']);
    tenantAId = getTenantStore().create('Tenant A', [keyA.id]).id;
    // Old entries so they also appear on the stale readers.
    seed({ keyId: keyA.id, text: TEXT_A, provider: 'openai', daysAgo: 40, tenantId: tenantAId });
    seed({ keyId: keyB.id, text: TEXT_B, provider: 'claude', daysAgo: 40 });
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('SHR1: GET /scans/usage — B sees none of A, A sees its own, admin sees both', async () => {
    const b = await get('/scans/usage', keyB.key);
    const a = await get('/scans/usage', keyA.key);
    const admin = await get('/scans/usage', ADMIN_KEY);
    expect(b.status).toBe(200);
    expect(JSON.parse(b.body).total).toBe(1);
    expect(b.body).not.toContain('ALPHA-PRIVATE');
    expect(b.body).not.toContain(hashText(TEXT_A));
    expect(a.body).toContain('ALPHA-PRIVATE');
    expect(a.body).not.toContain('BRAVO-PRIVATE');
    expect(JSON.parse(admin.body).total).toBe(2);
  });

  it('SHR2: GET /scans/usage?tenantId=<A\'s tenant> as B returns nothing', async () => {
    const b = await get(`/scans/usage?tenantId=${tenantAId}`, keyB.key);
    expect(b.status).toBe(200);
    expect(JSON.parse(b.body).total).toBe(0);
    expect(b.body).not.toContain('ALPHA-PRIVATE');
    const a = await get(`/scans/usage?tenantId=${tenantAId}`, keyA.key);
    expect(JSON.parse(a.body).total).toBe(1);
  });

  it('SHR3: GET /scans/stale/view — B\'s dashboard does not show A\'s preview', async () => {
    const b = await get('/scans/stale/view', keyB.key);
    expect(b.status).toBe(200);
    expect(b.body).toContain('BRAVO-PRIVATE');
    expect(b.body).not.toContain('ALPHA-PRIVATE');
    expect(b.body).not.toContain(hashText(TEXT_A).slice(0, 8));
  });

  it('SHR4: GET /scans/stale/view — admin sees both keys\' previews', async () => {
    const admin = await get('/scans/stale/view', ADMIN_KEY);
    expect(admin.body).toContain('ALPHA-PRIVATE');
    expect(admin.body).toContain('BRAVO-PRIVATE');
  });

  it('SHR5: GET /scans/stale — B sees only its own stale document', async () => {
    const b = JSON.parse((await get('/scans/stale', keyB.key)).body);
    expect(b.count).toBe(1);
    expect(b.scans[0].keyId).toBe(keyB.id);
    const admin = JSON.parse((await get('/scans/stale', ADMIN_KEY)).body);
    expect(admin.count).toBe(2);
  });

  it('SHR6: GET /scans/stale?tenantId=<A\'s tenant> as B returns nothing', async () => {
    const b = await get(`/scans/stale?tenantId=${tenantAId}`, keyB.key);
    expect(JSON.parse(b.body).count).toBe(0);
    expect(b.body).not.toContain('ALPHA-PRIVATE');
  });

  it('SHR7: GET /scans/search?q= — B cannot find A\'s text; A can', async () => {
    const b = JSON.parse((await get('/scans/search?q=ALPHA', keyB.key)).body);
    expect(b.scans).toEqual([]);
    const a = JSON.parse((await get('/scans/search?q=ALPHA', keyA.key)).body);
    expect(a.scans).toHaveLength(1);
    expect(a.scans[0].textPreview).toBe(TEXT_A);
  });

  it('SHR8: GET /scans/search — no filter as B lists only B; tenantId=A as B lists nothing', async () => {
    const all = JSON.parse((await get('/scans/search', keyB.key)).body);
    expect(all.scans).toHaveLength(1);
    expect(all.scans[0].keyId).toBe(keyB.id);
    const viaTenant = JSON.parse((await get(`/scans/search?tenantId=${tenantAId}`, keyB.key)).body);
    expect(viaTenant.scans).toEqual([]);
    const admin = JSON.parse((await get('/scans/search', ADMIN_KEY)).body);
    expect(admin.scans).toHaveLength(2);
  });

  it('SHR9: GET /scans/timeline?text= — B cannot probe whether A scanned a text', async () => {
    const b = JSON.parse((await get(`/scans/timeline?text=${encodeURIComponent(TEXT_A)}`, keyB.key)).body);
    expect(b.scanCount).toBe(0);
    const a = JSON.parse((await get(`/scans/timeline?text_hash=${hashText(TEXT_A)}`, keyA.key)).body);
    expect(a.scanCount).toBe(1);
    const admin = JSON.parse((await get(`/scans/timeline?text_hash=${hashText(TEXT_A)}`, ADMIN_KEY)).body);
    expect(admin.scanCount).toBe(1);
  });

  it('SHR10: POST /export — B\'s export holds none of A\'s rows', async () => {
    const exportAs = (key: string) => server.inject({
      method: 'POST',
      url: '/export',
      headers: { ...as(key), 'content-type': 'application/json' },
      payload: { format: 'json' },
    });
    const b = await exportAs(keyB.key);
    expect(b.statusCode).toBe(200);
    expect(b.headers['x-export-count']).toBe('1');
    expect(b.body).toContain('BRAVO-PRIVATE');
    expect(b.body).not.toContain('ALPHA-PRIVATE');
    expect(b.body).not.toContain(keyA.id);
    const admin = await exportAs(ADMIN_KEY);
    expect(admin.headers['x-export-count']).toBe('2');
  });

  it('SHR11: GET /analytics/overview — B\'s totals and providers exclude A', async () => {
    const b = JSON.parse((await get('/analytics/overview', keyB.key)).body);
    expect(b.summary.totalScans).toBe(1);
    expect(b.providerDistribution).toEqual([{ provider: 'claude', count: 1 }]);
    const admin = JSON.parse((await get('/analytics/overview', ADMIN_KEY)).body);
    expect(admin.summary.totalScans).toBe(2);
  });

  it('SHR12: a keystore key holding the admin permission keeps fleet-wide reads', async () => {
    const keystoreAdmin = getKeyStore().create('Ops admin', ['admin']);
    const res = JSON.parse((await get('/scans/usage', keystoreAdmin.key)).body);
    expect(res.total).toBe(2);
  });

  it('SHR13: DELETE /scans/stale stays admin-only (a scan key gets 403 and deletes nothing)', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/scans/stale?days=30', headers: as(keyB.key) });
    expect(res.statusCode).toBe(403);
    expect(getScanHistory().size).toBe(2);
  });

  it('SHR14: a key with no scans sees an empty history on every reader', async () => {
    const keyC = getKeyStore().create('Key C', ['scan']);
    expect(JSON.parse((await get('/scans/usage', keyC.key)).body).total).toBe(0);
    expect(JSON.parse((await get('/scans/stale', keyC.key)).body).count).toBe(0);
    expect(JSON.parse((await get('/scans/search', keyC.key)).body).scans).toEqual([]);
    expect(JSON.parse((await get('/analytics/overview', keyC.key)).body).summary.totalScans).toBe(0);
    const view = await get('/scans/stale/view', keyC.key);
    expect(view.body).toContain('No scan history found.');
  });
});

// ── HTML escaping ─────────────────────────────────────────────────────────────

describe('server-side HTML dashboards escape user input', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = ADMIN_KEY;
    resetAll();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('SHX1: /scans/stale/view renders a <script> preview as text, for the planter', async () => {
    const planter = getKeyStore().create('Planter', ['scan']);
    seed({ keyId: planter.id, text: XSS_TEXT, daysAgo: 40 });
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: { 'x-api-key': planter.key } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script>');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('SHX2: /scans/stale/view escapes the title attribute (no quote breakout)', async () => {
    seed({ keyId: 'k-any', text: XSS_TEXT, daysAgo: 40 });
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: { 'x-api-key': ADMIN_KEY } });
    expect(res.body).toContain('title="&lt;script&gt;alert(1)&lt;/script&gt; injected preview &quot;quoted&quot;"');
    expect(res.body).not.toContain('"quoted"');
  });

  it('SHX3: /scans/stale/view escapes provider strings', async () => {
    seed({ keyId: 'k-any', text: TEXT_A, provider: '<img src=x onerror=alert(2)>', daysAgo: 40 });
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: { 'x-api-key': ADMIN_KEY } });
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('SHX4: /keys/usage/view renders a <script> key name as text', async () => {
    getKeyStore().create('<script>alert(1)</script>', ['scan']);
    const res = await server.inject({ method: 'GET', url: '/keys/usage/view', headers: { 'x-api-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script>');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
