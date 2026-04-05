/**
 * Scan Templates Tests (D-132)
 *
 * Covers: POST /templates, GET /templates, DELETE /templates/:id,
 * POST /scan/template/:id, and TemplateStore unit behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCache } from '../src/store/cache.js';
import { resetTemplateStore, getTemplateStore } from '../src/store/templates.js';
import { resetProviderRegistry } from '../src/store/providers.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'Test claim.',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'Test claim.', type: 'fact', importance: 3 }],
    verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] } },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [], euRiskSummary: { totalClaims: 1, highestTier: 'minimal', unacceptable: 0, high: 0, limited: 0, minimal: 1 } },
    ruleFindings: [],
  }),
}));

vi.mock('@nxtg/faultline/cli/extract.js', () => ({
  extractTextFromBuffer: vi.fn().mockResolvedValue('Test claim.'),
}));

const ADMIN = 'admin-secret';
const JSON_HDR = { 'content-type': 'application/json' };

function authHeaders() {
  return { 'x-api-key': ADMIN, ...JSON_HDR };
}

let server: FastifyInstance;

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = ADMIN;
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
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

// ── POST /templates ───────────────────────────────────────────────────────────

describe('POST /templates', () => {
  it('201 with name only — minimal template', async () => {
    const res = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'minimal-template' }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.name).toBe('minimal-template');
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('201 with all optional fields', async () => {
    const res = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'compliance-check',
        provider: 'mock',
        rules: ['pii', 'bias'],
        failOn: 'high',
        description: 'Standard compliance template',
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.provider).toBe('mock');
    expect(body.rules).toEqual(['pii', 'bias']);
    expect(body.failOn).toBe('high');
    expect(body.description).toBe('Standard compliance template');
  });

  it('id is a UUID string', async () => {
    const res = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'uuid-check' }),
    });
    const body = JSON.parse(res.body);
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('400 missing name', async () => {
    const res = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ provider: 'mock' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 invalid provider enum', async () => {
    const res = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'bad', provider: 'unknown-provider' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 invalid failOn enum', async () => {
    const res = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'bad', failOn: 'extreme' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('401 without api key', async () => {
    const res = await server.inject({
      method: 'POST', url: '/templates',
      body: JSON.stringify({ name: 'unauth' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── GET /templates ────────────────────────────────────────────────────────────

describe('GET /templates', () => {
  it('200 returns empty array initially', async () => {
    const res = await server.inject({ method: 'GET', url: '/templates', headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('200 returns created templates (Gate 2: length > 0)', async () => {
    await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'template-one', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/templates', headers: authHeaders() });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body);
    expect(list.length).toBeGreaterThan(0); // Gate 2
    expect(list[0].name).toBe('template-one');
  });

  it('multiple templates all returned', async () => {
    for (const name of ['tmpl-a', 'tmpl-b', 'tmpl-c']) {
      await server.inject({
        method: 'POST', url: '/templates',
        headers: authHeaders(),
        body: JSON.stringify({ name }),
      });
    }
    const res = await server.inject({ method: 'GET', url: '/templates', headers: authHeaders() });
    const list = JSON.parse(res.body);
    expect(list.length).toBe(3); // Gate 2
  });

  it('401 without api key', async () => {
    const res = await server.inject({ method: 'GET', url: '/templates' });
    expect(res.statusCode).toBe(401);
  });
});

// ── DELETE /templates/:id ─────────────────────────────────────────────────────

describe('DELETE /templates/:id', () => {
  it('204 on successful delete', async () => {
    const create = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'to-delete' }),
    });
    const { id } = JSON.parse(create.body);

    const res = await server.inject({
      method: 'DELETE', url: `/templates/${id}`,
      headers: { 'x-api-key': ADMIN },
    });
    expect(res.statusCode).toBe(204);
  });

  it('404 for unknown id', async () => {
    const res = await server.inject({
      method: 'DELETE', url: '/templates/nonexistent-id',
      headers: { 'x-api-key': ADMIN },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('Template not found.');
  });

  it('GET /templates after delete shows reduced count', async () => {
    const r1 = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'keep' }),
    });
    const r2 = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'delete-me' }),
    });
    const { id } = JSON.parse(r2.body);

    await server.inject({ method: 'DELETE', url: `/templates/${id}`, headers: { 'x-api-key': ADMIN } });

    const list = await server.inject({ method: 'GET', url: '/templates', headers: authHeaders() });
    expect(JSON.parse(list.body).length).toBe(1); // Gate 2
    expect(JSON.parse(list.body)[0].name).toBe('keep');
  });
});

// ── POST /scan/template/:id ───────────────────────────────────────────────────

describe('POST /scan/template/:id', () => {
  it('200 scan using template provider', async () => {
    const create = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'scan-tmpl', provider: 'mock' }),
    });
    const { id } = JSON.parse(create.body);

    const res = await server.inject({
      method: 'POST', url: `/scan/template/${id}`,
      headers: authHeaders(),
      body: JSON.stringify({ text: 'Test claim.' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.overallRisk).toBeDefined();
    expect(body.claims.length).toBeGreaterThan(0); // Gate 2
  });

  it('body provider overrides template provider', async () => {
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    const mockScan = vi.mocked(scan);

    const create = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'override-tmpl', provider: 'gemini' }),
    });
    const { id } = JSON.parse(create.body);

    await server.inject({
      method: 'POST', url: `/scan/template/${id}`,
      headers: authHeaders(),
      body: JSON.stringify({ text: 'Test.', provider: 'mock' }),
    });

    const lastCall = mockScan.mock.calls[mockScan.mock.calls.length - 1];
    expect(lastCall?.[1]).toBe('mock');
  });

  it('404 for unknown template id', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/template/nonexistent-id',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'Test.' }),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('Template not found.');
  });

  it('400 missing text field', async () => {
    const create = await server.inject({
      method: 'POST', url: '/templates',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'no-text-tmpl' }),
    });
    const { id } = JSON.parse(create.body);

    const res = await server.inject({
      method: 'POST', url: `/scan/template/${id}`,
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it('401 without api key', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/template/any-id',
      body: JSON.stringify({ text: 'Test.' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── TemplateStore unit tests ──────────────────────────────────────────────────

describe('TemplateStore', () => {
  it('list() empty initially', () => {
    expect(getTemplateStore().list()).toHaveLength(0);
  });

  it('create() stores and returns template', () => {
    const store = getTemplateStore();
    const t = store.create('my-template', { provider: 'mock', rules: ['pii'] });
    expect(t.id).toBeDefined();
    expect(t.name).toBe('my-template');
    expect(t.provider).toBe('mock');
    expect(t.rules).toEqual(['pii']);
    expect(store.list().length).toBe(1); // Gate 2
  });

  it('get() returns created template', () => {
    const store = getTemplateStore();
    const t = store.create('get-test');
    expect(store.get(t.id)).toBeDefined();
    expect(store.get(t.id)?.name).toBe('get-test');
  });

  it('get() returns undefined for unknown id', () => {
    expect(getTemplateStore().get('not-a-real-id')).toBeUndefined();
  });

  it('delete() returns false for unknown id', () => {
    expect(getTemplateStore().delete('not-a-real-id')).toBe(false);
  });

  it('reset() clears all templates', () => {
    const store = getTemplateStore();
    store.create('a');
    store.create('b');
    store.reset();
    expect(store.list()).toHaveLength(0);
  });
});
