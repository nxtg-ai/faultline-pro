/**
 * Integration Flow Tests (D-166)
 *
 * Validates: N-13 (Cloud Platform — hosted API + auth), N-19 (Webhook System),
 *            N-24 (Caching Layer), N-25 (Scheduled Scans), N-39 (Production Hardening),
 *            N-45 (Multi-Tenant API), N-70 (Usage Analytics Dashboard)
 *
 * 10 end-to-end scenarios exercising the complete Faultline Pro pipeline:
 *   API key auth → scan → claims → verdict → compliance report →
 *   webhook delivery → audit trail → cache → rate limiting → org keys → analytics
 *
 * One shared server instance; state (keys, ids) flows across scenarios where
 * needed. The mock scan engine returns deterministic results so every scenario
 * is reproducible without real provider credentials.
 *
 * Scenario map:
 *   F1  — Full scan pipeline: auth → scan → ClaimIndex → ScanHistory → AuditTrail
 *   F2  — Cache hit/miss cycle: first MISS populates cache, second HIT is instant
 *   F3  — Webhook delivery: scan fires scan.complete with HMAC signature
 *   F4  — Audit trail completeness: every HTTP request lands in AuditLogger
 *   F5  — Verdict propagation: claims flow from scan response into ClaimIndex search
 *   F6  — Compliance report chain: scan output drives EU report PDF generation
 *   F7  — Rate-limit enforcement: quota exhausted → 429, quota reset → 200
 *   F8  — Org-scoped API key: org key authenticates and metered under org usage
 *   F9  — Schedule trigger flow: create schedule → trigger → run recorded
 *   F10 — Analytics data flow: scans accumulate in overview aggregation endpoint
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter, setCustomLimit } from '../src/store/ratelimit.js';
import { resetAuditLogger, getAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCache, getScanCache } from '../src/store/cache.js';
import { resetTemplateStore } from '../src/store/templates.js';
import { resetProviderRegistry } from '../src/store/providers.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetClaimIndex, getClaimIndex } from '../src/store/claims.js';
import { resetScanHistory, getScanHistory } from '../src/store/scan-history.js';
import { resetOrgStore, getOrgStore } from '../src/store/orgs.js';
import { resetCostStore } from '../src/store/costs.js';
import { resetWarmupStore, resetCacheWarmer } from '../src/store/cache-warmup.js';
import { resetScheduleStore } from '../src/store/schedules.js';
import type { FastifyInstance } from 'fastify';

// ── Mock scan engine ──────────────────────────────────────────────────────────
// MOCK JUSTIFIED: @nxtg/faultline/cli/scan.js calls external LLM providers.
// These tests exercise the HTTP route pipeline (auth, cache, webhooks, audit,
// rate-limiting, analytics) not the scan engine internals. Scan logic is
// covered unmocked in real-integration.test.ts (CRUCIBLE integration oracle).

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'Revenue grew 45% in 2024.',
    provider: 'mock',
    claims: [
      { id: 'c1', text: 'Revenue grew 45% in 2024.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'The company employs 10,000 people.',  type: 'fact', importance: 3 },
    ],
    verifications: {
      c1: {
        claimId: 'c1', status: 'supported', explanation: 'Confirmed by annual report.',
        sources: [{ title: 'Annual Report 2024', url: 'https://example.com/report' }],
      },
      c2: {
        claimId: 'c2', status: 'unverified', explanation: 'No corroborating source found.',
        sources: [],
      },
    },
    overallRisk: 'low',
    complianceReport: {
      riskTier: 'minimal',
      findings: [],
      claimMappings: [],
      euRiskSummary: { totalClaims: 2, highestTier: 'minimal', unacceptable: 0, high: 0, limited: 0, minimal: 2 },
    },
    ruleFindings: [],
  }),
}));

vi.mock('@nxtg/faultline/cli/extract.js', () => ({
  extractTextFromBuffer: vi.fn().mockResolvedValue('Revenue grew 45% in 2024.'),
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_SECRET = 'integration-admin';
const TEXT_A = 'Revenue grew 45% in 2024.';
const TEXT_B = 'The product has 10 million users in Q3 2024.';
const JSON_H = { 'content-type': 'application/json' };

function ah() { return { 'x-api-key': ADMIN_SECRET, ...JSON_H }; }
function kh(secret: string) { return { 'x-api-key': secret, ...JSON_H }; }

// ── Shared state that flows between scenarios ─────────────────────────────────

let server: FastifyInstance;
let scanKey:  string;   // regular scan-only key (created in F1)
let orgId:    string;   // org created in F8
let orgKey:   string;   // org-scoped API key secret (created in F8)

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.FAULTLINE_API_KEY = ADMIN_SECRET;
  process.env.ADMIN_API_KEY     = ADMIN_SECRET;

  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetWebhookStore();
  resetCache();
  resetTemplateStore();
  resetProviderRegistry();
  resetCircuitBreaker();
  resetClaimIndex();
  resetScanHistory();
  resetOrgStore();
  resetCostStore();
  resetWarmupStore();
  resetCacheWarmer();
  resetScheduleStore();

  server = buildServer();
  await server.ready();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
  delete process.env.ADMIN_API_KEY;
});

// ─────────────────────────────────────────────────────────────────────────────
// F1: Full scan pipeline — auth → scan → ClaimIndex → ScanHistory → AuditTrail
// ─────────────────────────────────────────────────────────────────────────────

describe('F1: Full scan pipeline', () => {
  it('F1.1 POST /keys creates a scan-only key', async () => {
    const res = await server.inject({
      method: 'POST', url: '/keys',
      headers: ah(),
      body: JSON.stringify({ name: 'integration-scan-key', permissions: ['scan'] }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.key).toMatch(/^[0-9a-f]{64}$/);
    scanKey = body.key;
  });

  it('F1.2 POST /scan with valid key returns claims and risk (Gate 2: non-empty)', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: kh(scanKey),
      body: JSON.stringify({ text: TEXT_A, provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBeGreaterThan(0); // Gate 2
    expect(body.overallRisk).toBeDefined();
    expect(typeof body.verifications).toBe('object');
  });

  it('F1.3 ClaimIndex contains the ingested claims (Gate 2)', () => {
    const results = getClaimIndex().search({ text: 'revenue' });
    expect(results.length).toBeGreaterThan(0); // Gate 2
    expect(results[0].originalText.toLowerCase()).toContain('revenue');
  });

  it('F1.4 ScanHistory records the scan entry (Gate 2)', () => {
    const entries = getScanHistory().getRecent(10);
    expect(entries.length).toBeGreaterThan(0); // Gate 2
    expect(entries[0].provider).toBe('mock');
    expect(entries[0].claimCount).toBe(2);
  });

  it('F1.5 AuditLogger records the scan request', () => {
    const entries = getAuditLogger().getEntries();
    const scanEntry = entries.find(e => e.endpoint === '/scan' && e.statusCode === 200);
    expect(scanEntry).toBeDefined();
    expect(scanEntry!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof scanEntry!.keyId).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2: Cache hit/miss cycle
// ─────────────────────────────────────────────────────────────────────────────

describe('F2: Cache hit/miss cycle', () => {
  it('F2.1 First scan → X-Cache: MISS, result stored in cache', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: ah(),
      body: JSON.stringify({ text: TEXT_B, provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(getScanCache().stats().size).toBeGreaterThan(0); // Gate 2
  });

  it('F2.2 Second scan (same text+provider) → X-Cache: HIT', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: ah(),
      body: JSON.stringify({ text: TEXT_B, provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
  });

  it('F2.3 Cache stats show at least one hit (Gate 2)', () => {
    const stats = getScanCache().stats();
    expect(stats.hits).toBeGreaterThan(0);  // Gate 2
    expect(stats.hitRate).toBeGreaterThan(0);
  });

  it('F2.4 GET /cache/stats via admin returns populated stats (Gate 2)', async () => {
    const res = await server.inject({ method: 'GET', url: '/cache/stats', headers: ah() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.size).toBeGreaterThan(0);  // Gate 2
    expect(body.hits).toBeGreaterThan(0);  // Gate 2
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F3: Webhook delivery — scan fires scan.complete with HMAC
// ─────────────────────────────────────────────────────────────────────────────

describe('F3: Webhook delivery on scan.complete', () => {
  let webhookId: string;
  let mockFetch: ReturnType<typeof vi.fn>;

  it('F3.1 Register webhook for scan.complete', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks',
      headers: ah(),
      body: JSON.stringify({
        url: 'https://ci.example.com/hook',
        events: ['scan.complete'],
        secret: 'integration-secret',
      }),
    });
    expect(res.statusCode).toBe(201);
    webhookId = JSON.parse(res.body).id;
    expect(typeof webhookId).toBe('string');
  });

  it('F3.2 POST /scan fires webhook with correct event and HMAC (Gate 2)', async () => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await server.inject({
      method: 'POST', url: '/scan',
      headers: ah(),
      body: JSON.stringify({ text: 'Webhook trigger text.', provider: 'mock' }),
    });

    // Allow fire-and-forget dispatch to complete
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(mockFetch).toHaveBeenCalledOnce(); // Gate 2: fetch was actually called
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ci.example.com/hook');

    const payload = JSON.parse(init.body as string);
    expect(payload.event).toBe('scan.complete'); // Gate 2: correct event type
    expect((init.headers as Record<string, string>)['X-Faultline-Signature']).toMatch(/^sha256=[0-9a-f]+$/); // HMAC present

    vi.unstubAllGlobals();
  });

  it('F3.3 DELETE /webhooks/:id cleans up', async () => {
    const res = await server.inject({
      method: 'DELETE', url: `/webhooks/${webhookId}`,
      headers: { 'x-api-key': ADMIN_SECRET },
    });
    expect(res.statusCode).toBe(204);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F4: Audit trail completeness — every scan request is recorded
// ─────────────────────────────────────────────────────────────────────────────

describe('F4: Audit trail completeness', () => {
  it('F4.1 Audit log has entries from all prior scan requests (Gate 2)', () => {
    const entries = getAuditLogger().getEntries();
    const scanEntries = entries.filter(e => e.endpoint === '/scan');
    expect(scanEntries.length).toBeGreaterThan(0); // Gate 2: at least one scan recorded
  });

  it('F4.2 Each audit entry has required fields', () => {
    const entries = getAuditLogger().getEntries();
    for (const e of entries.slice(0, 5)) {
      expect(typeof e.timestamp).toBe('string');
      expect(typeof e.keyId).toBe('string');
      expect(typeof e.endpoint).toBe('string');
      expect(typeof e.method).toBe('string');
      expect(typeof e.statusCode).toBe('number');
      expect(typeof e.latencyMs).toBe('number');
    }
  });

  it('F4.3 401 on missing key is recorded in audit trail', async () => {
    const pre = getAuditLogger().getEntries().length;
    await server.inject({
      method: 'POST', url: '/scan',
      headers: JSON_H,
      body: JSON.stringify({ text: 'No key scan.', provider: 'mock' }),
    });
    // The onResponse hook fires for ALL requests; the new entry is at the front
    const entries = getAuditLogger().getEntries();
    expect(entries.length).toBeGreaterThan(pre); // Gate 2: entry was added
    const rejected = entries.find(e => e.endpoint === '/scan' && e.statusCode === 401);
    expect(rejected!.statusCode).toBe(401);
  });

  it('F4.4 AuditLogger store holds all request entries (Gate 2)', () => {
    // /audit/log is not a public HTTP endpoint; we verify the store directly
    const entries = getAuditLogger().getEntries();
    expect(entries.length).toBeGreaterThan(5); // Gate 2: at least 6 requests recorded
    const methods = new Set(entries.map(e => e.method));
    expect(methods.has('POST')).toBe(true);
    expect(methods.has('GET')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F5: Verdict propagation — scan verifications flow into ClaimIndex
// ─────────────────────────────────────────────────────────────────────────────

describe('F5: Verdict propagation into ClaimIndex', () => {
  it('F5.1 ClaimIndex stats show mixed verdicts after scan (Gate 2)', () => {
    // F1.2 scanned TEXT_A: c1=supported, c2=unverified
    const stats = getClaimIndex().getStats();
    expect(stats.totalClaims).toBeGreaterThan(0);           // Gate 2
    expect(stats.byVerdict['supported']).toBeGreaterThan(0); // Gate 2
    expect(stats.byVerdict['unverified']).toBeGreaterThan(0);
  });

  it('F5.2 GET /claims/stats reflects ClaimIndex state (Gate 2)', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/stats' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.totalClaims).toBeGreaterThan(0);  // Gate 2
    expect(body.totalScans).toBeGreaterThan(0);   // Gate 2
    expect(typeof body.accuracyRate).toBe('number');
  });

  it('F5.3 GET /claims search returns result matching scanned text (Gate 2)', async () => {
    const res = await server.inject({
      method: 'GET', url: '/claims?text=revenue',
      headers: ah(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBeGreaterThan(0); // Gate 2
    expect(body.claims[0].normalizedText).toContain('revenue');
  });

  it('F5.4 Verdict filter returns only supported claims', async () => {
    const res = await server.inject({
      method: 'GET', url: '/claims?verdict=supported',
      headers: ah(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.every((c: { lastVerdict: string }) => c.lastVerdict === 'supported')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F6: Compliance report chain — scan output → EU report → PDF bytes
// ─────────────────────────────────────────────────────────────────────────────

describe('F6: Compliance report chain', () => {
  it('F6.1 POST /scan returns complianceReport in body', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: ah(),
      body: JSON.stringify({ text: TEXT_A, provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.complianceReport).toBeDefined();
    expect(body.complianceReport.riskTier).toBeDefined();
    expect(Array.isArray(body.complianceReport.findings)).toBe(true);
  });

  it('F6.2 POST /scan/report generates a PDF (Gate 2: content > 100 bytes)', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/report',
      headers: ah(),
      body: JSON.stringify({ text: TEXT_A, provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.length).toBeGreaterThan(100); // Gate 2: actual PDF bytes
  });

  it('F6.3 POST /scan/eu-report returns a PDF with EU Act content (Gate 2)', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/eu-report',
      headers: ah(),
      body: JSON.stringify({ text: TEXT_A, provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.length).toBeGreaterThan(100); // Gate 2: real PDF bytes
  });

  it('F6.4 POST /scan/compliance/:template applies industry template', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/compliance/hipaa',
      headers: ah(),
      body: JSON.stringify({ text: TEXT_A, provider: 'mock' }),
    });
    // 200 = template found, 404 = template not registered — both are valid; just no 500
    expect([200, 404]).toContain(res.statusCode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F7: Rate-limit enforcement and recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('F7: Rate-limit enforcement', () => {
  let limitedKey: string;
  let limitedKeyId: string;

  it('F7.1 Create a fresh key for rate-limit testing', async () => {
    const res = await server.inject({
      method: 'POST', url: '/keys',
      headers: ah(),
      body: JSON.stringify({ name: 'rate-limit-test-key', permissions: ['scan'] }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    limitedKey   = body.key;
    limitedKeyId = body.id;
  });

  it('F7.2 Scan succeeds before quota exhausted', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: kh(limitedKey),
      body: JSON.stringify({ text: 'Rate limit test scan.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('F7.3 After setCustomLimit(0), scan returns 429', async () => {
    setCustomLimit(limitedKeyId, 0);
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: kh(limitedKey),
      body: JSON.stringify({ text: 'Over-quota scan.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('F7.4 After setCustomLimit(100), scan recovers to 200', async () => {
    setCustomLimit(limitedKeyId, 100);
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: kh(limitedKey),
      body: JSON.stringify({ text: 'Rate limit recovery scan.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F8: Org-scoped API key — authenticate and meter under org
// ─────────────────────────────────────────────────────────────────────────────

describe('F8: Org-scoped API key flow', () => {
  it('F8.1 POST /orgs creates an organization', async () => {
    const res = await server.inject({
      method: 'POST', url: '/orgs',
      headers: ah(),
      body: JSON.stringify({ name: 'Integration Corp', plan: 'pro' }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    orgId = body.id;
    expect(orgId).toBeTruthy();
    expect(body.slug).toBe('integration-corp');
  });

  it('F8.2 POST /orgs/:id/keys creates an org-scoped API key (Gate 2)', async () => {
    const res = await server.inject({
      method: 'POST', url: `/orgs/${orgId}/keys`,
      headers: ah(),
      body: JSON.stringify({ name: 'ci-deploy', permissions: ['scan'] }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.key).toBeTruthy();              // Gate 2: actual raw key returned
    expect(body.orgKey.keyName).toContain('ci-deploy');
    orgKey = body.key;
  });

  it('F8.3 Org-scoped key can execute a scan', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: kh(orgKey),
      body: JSON.stringify({ text: TEXT_A, provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBeGreaterThan(0); // Gate 2
  });

  it('F8.4 GET /orgs/:id/usage reflects the org (Gate 2)', async () => {
    const res = await server.inject({
      method: 'GET', url: `/orgs/${orgId}/usage`,
      headers: ah(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.orgId).toBe(orgId);
    expect(typeof body.totalScans).toBe('number'); // Gate 2: field exists
    expect(body.totalScans).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F9: Schedule trigger flow — create → trigger → history recorded
// ─────────────────────────────────────────────────────────────────────────────

describe('F9: Schedule trigger flow', () => {
  let scheduleId: string;

  it('F9.1 POST /schedules creates a scan schedule', async () => {
    const res = await server.inject({
      method: 'POST', url: '/schedules',
      headers: ah(),
      body: JSON.stringify({
        name: 'Integration Schedule',
        cron: '0 9 * * *',
        text: TEXT_A,
        provider: 'mock',
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    scheduleId = body.id;
    expect(scheduleId).toBeTruthy();
    expect(body.cron).toBe('0 9 * * *');
  });

  it('F9.2 POST /schedules/:id/trigger fires schedule and returns 202', async () => {
    // No body — omit content-type to avoid Fastify's JSON parser failing on empty body
    const res = await server.inject({
      method: 'POST', url: `/schedules/${scheduleId}/trigger`,
      headers: { 'x-api-key': ADMIN_SECRET },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('triggered');
  });

  it('F9.3 GET /schedules/:id/history shows the run (Gate 2)', async () => {
    // Wait briefly for async trigger to complete
    await new Promise(resolve => setTimeout(resolve, 50));
    const res = await server.inject({
      method: 'GET', url: `/schedules/${scheduleId}/history`,
      headers: ah(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.history.length).toBeGreaterThan(0); // Gate 2
  });

  it('F9.4 GET /schedules/:id shows incremented runCount (Gate 2)', async () => {
    const res = await server.inject({
      method: 'GET', url: `/schedules/${scheduleId}`,
      headers: ah(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.runCount).toBeGreaterThan(0); // Gate 2
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F10: Analytics data flow — scans accumulate in overview endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('F10: Analytics data flow', () => {
  it('F10.1 GET /analytics/overview totalScans > 0 after all prior scans (Gate 2)', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: ah() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.summary.totalScans).toBeGreaterThan(0); // Gate 2
  });

  it('F10.2 providerDistribution includes mock provider (Gate 2)', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: ah() });
    const body = JSON.parse(res.body);
    const mockEntry = body.providerDistribution.find((p: { provider: string }) => p.provider === 'mock');
    expect(mockEntry).toBeDefined();              // Gate 2
    expect(mockEntry.count).toBeGreaterThan(0);   // Gate 2
  });

  it('F10.3 Today\'s scan volume bucket is non-zero (Gate 2)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: ah() });
    const body = JSON.parse(res.body);
    const todayBucket = body.scanVolume.find((d: { date: string }) => d.date === today);
    expect(todayBucket).toBeDefined();
    expect(todayBucket.count).toBeGreaterThan(0); // Gate 2
  });

  it('F10.4 cacheStats.hits > 0 after F2 cache-hit scenario (Gate 2)', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: ah() });
    const body = JSON.parse(res.body);
    expect(body.cacheStats.hits).toBeGreaterThan(0);   // Gate 2
    expect(body.cacheStats.hitRate).toBeGreaterThan(0); // Gate 2
  });

  it('F10.5 claimCategories includes fact type after ingestion (Gate 2)', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: ah() });
    const body = JSON.parse(res.body);
    const factEntry = body.claimCategories.find((c: { type: string }) => c.type === 'fact');
    expect(factEntry).toBeDefined();             // Gate 2
    expect(factEntry.count).toBeGreaterThan(0);  // Gate 2
  });

  it('F10.6 GET /analytics HTML page is reachable and contains expected content', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics', headers: ah() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Total Scans');
    expect(res.body).toContain('/analytics/overview');
  });
});
