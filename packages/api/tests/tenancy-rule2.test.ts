// Validates: route audit 647bc10 findings H2, L1, M1-M6 (emma-soul al:837ec6cea3437a7d, rule 2; GoPMO 1.18.11.3)
//
// One test per finding: key B must not read or change key A's stored objects,
// and an admin key still sees them. Each test failed on 767075d (red-before) and
// passes here. Objects stored with no owner (before owners were recorded) are
// admin-only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getScanQueue, resetScanQueue } from '../src/store/scan-queue.js';
import { getTemplateStore, resetTemplateStore } from '../src/store/templates.js';
import { getCostStore, resetCostStore } from '../src/store/costs.js';
import { getComplianceHistoryStore, resetComplianceHistoryStore } from '../src/store/compliance-history.js';
import { getRateLimiter, resetRateLimiter } from '../src/store/ratelimit.js';
import { getRateLimitAlertStore, resetRateLimitAlertStore } from '../src/store/rate-alerts.js';
import { getScanStore, resetScanStore } from '../src/store/scans.js';
import { getApprovalStore, resetApprovalStore } from '../src/store/approvals.js';
import { resetNotificationStore } from '../src/store/notifications.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAuditLogger } from '../src/store/audit.js';

// Scans run on the engine's own mock provider (provider: 'mock').
const ADMIN = 'admin-secret';
const CANARY = 'CANARY-A-7f3e';

// Rule 2 tests create non-admin keys; customer keys are closed in production.
beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

let server: FastifyInstance;
let keyA: { id: string; key: string };
let keyB: { id: string; key: string };

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = ADMIN;
  resetKeyStore(); resetScanQueue(); resetTemplateStore(); resetCostStore(); resetComplianceHistoryStore();
  resetRateLimiter(); resetRateLimitAlertStore(); resetScanStore(); resetApprovalStore();
  resetNotificationStore(); resetUsageMeter(); resetAuditLogger();
  keyA = getKeyStore().create('tenant-a', ['scan', 'report', 'upload', 'pro']);
  keyB = getKeyStore().create('tenant-b', ['scan', 'report', 'upload', 'pro']);
  server = buildServer();
  await server.ready();
  getScanQueue().stop(); // keep queued items pending
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

function as(key: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) {
  return server.inject({
    method, url,
    headers: { 'x-api-key': key, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

describe('H2/L1 scan queue items belong to the key that queued them', () => {
  it('H2: GET /queue/scans/:id is 404 for another key, 200 for the owner and admin', async () => {
    const item = getScanQueue().enqueue(keyA.id, 2, `queued ${CANARY}`, 'mock');
    const b = await as(keyB.key, 'GET', `/queue/scans/${item.id}`);
    expect(b.statusCode).toBe(404);
    expect(b.body).not.toContain(CANARY);
    expect(b.body).not.toContain(keyA.id);
    expect((await as(keyA.key, 'GET', `/queue/scans/${item.id}`)).body).toContain(CANARY);
    expect((await as(ADMIN, 'GET', `/queue/scans/${item.id}`)).statusCode).toBe(200);
  });

  it('L1: DELETE /queue/scans/:id on another key\'s pending item is 404 and leaves it pending', async () => {
    const item = getScanQueue().enqueue(keyA.id, 2, 'pending item', 'mock');
    expect((await as(keyB.key, 'DELETE', `/queue/scans/${item.id}`)).statusCode).toBe(404);
    expect(getScanQueue().get(item.id)?.status).toBe('pending');
    expect((await as(keyA.key, 'DELETE', `/queue/scans/${item.id}`)).statusCode).toBe(204);
    expect(getScanQueue().get(item.id)?.status).toBe('cancelled');
  });

  it('L1: a non-pending item of another key reads 404, not 409', async () => {
    const item = getScanQueue().enqueue(keyA.id, 2, 'done item', 'mock');
    getScanQueue().cancel(item.id);
    expect((await as(keyB.key, 'DELETE', `/queue/scans/${item.id}`)).statusCode).toBe(404);
    expect((await as(keyA.key, 'DELETE', `/queue/scans/${item.id}`)).statusCode).toBe(409);
  });
});

describe('M1 templates belong to the key that created them', () => {
  async function createAsA(): Promise<string> {
    const res = await as(keyA.key, 'POST', '/templates', { name: `tpl ${CANARY}`, provider: 'mock' });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).id;
  }

  it('M1: GET /templates lists only the caller\'s templates (admin: all)', async () => {
    const id = await createAsA();
    const b = await as(keyB.key, 'GET', '/templates');
    expect(b.statusCode).toBe(200);
    expect(JSON.parse(b.body)).toEqual([]);
    expect(b.body).not.toContain(CANARY);
    expect(JSON.parse((await as(keyA.key, 'GET', '/templates')).body).map((t: { id: string }) => t.id)).toEqual([id]);
    expect((await as(ADMIN, 'GET', '/templates')).body).toContain(CANARY);
  });

  it('M1: DELETE /templates/:id by another key is 404 and the template survives', async () => {
    const id = await createAsA();
    expect((await as(keyB.key, 'DELETE', `/templates/${id}`)).statusCode).toBe(404);
    expect(getTemplateStore().get(id)).toBeDefined();
    expect((await as(keyA.key, 'DELETE', `/templates/${id}`)).statusCode).toBe(204);
    expect(getTemplateStore().get(id)).toBeUndefined();
  });

  it('M1: POST /scan/template/:id with another key\'s template is 404', async () => {
    const id = await createAsA();
    const b = await as(keyB.key, 'POST', `/scan/template/${id}`, { text: 'B scans with A template.', provider: 'mock' });
    expect(b.statusCode).toBe(404);
    expect((await as(keyA.key, 'POST', `/scan/template/${id}`, { text: 'A scans with its template.', provider: 'mock' })).statusCode).toBe(200);
  });
});

describe('M2 GET /costs returns only the caller\'s rows', () => {
  it('M2: another key\'s rows are absent, and ?keyId selects a key for admin only', async () => {
    getCostStore().record(keyA.id, 'openai', 'a'.repeat(400));
    getCostStore().record(keyB.id, 'openai', 'b'.repeat(40));
    const b = await as(keyB.key, 'GET', '/costs');
    expect(b.statusCode).toBe(200);
    const body = JSON.parse(b.body);
    expect(body.costs.length).toBe(1);
    expect(b.body).not.toContain(keyA.id);
    expect((await as(keyB.key, 'GET', `/costs?keyId=${keyA.id}`)).statusCode).toBe(403);
    expect((await as(keyB.key, 'GET', `/costs?keyId=${keyB.id}`)).statusCode).toBe(200);
    const admin = await as(ADMIN, 'GET', `/costs?keyId=${keyA.id}`);
    expect(JSON.parse(admin.body).costs.map((c: { keyId: string }) => c.keyId)).toEqual([keyA.id]);
  });
});

describe('M3 compliance history is per key', () => {
  async function gateAsA(): Promise<void> {
    const res = await as(keyA.key, 'POST', '/scan/compliance-gate', { text: 'The Earth orbits the Sun.', provider: 'mock', projectName: CANARY });
    expect(res.statusCode).toBeLessThanOrEqual(422);
    expect(getComplianceHistoryStore().size).toBe(1);
  }

  it('M3: the gate records the owner key', async () => {
    await gateAsA();
    expect(getComplianceHistoryStore().query({})[0].keyId).toBe(keyA.id);
  });

  it('M3: GET /compliance/history shows another key nothing; the owner and admin see the record', async () => {
    await gateAsA();
    const b = await as(keyB.key, 'GET', '/compliance/history');
    expect(JSON.parse(b.body).count).toBe(0);
    expect(b.body).not.toContain(CANARY);
    expect(JSON.parse((await as(keyA.key, 'GET', '/compliance/history')).body).count).toBe(1);
    expect(JSON.parse((await as(ADMIN, 'GET', '/compliance/history')).body).count).toBe(1);
  });

  it('M3: GET /compliance/export (JSON and CSV) holds only the caller\'s records', async () => {
    await gateAsA();
    const json = await as(keyB.key, 'GET', '/compliance/export?format=json');
    expect(JSON.parse(json.body).count).toBe(0);
    const csv = await as(keyB.key, 'GET', '/compliance/export?format=csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.body).not.toContain(CANARY);
    expect((await as(keyA.key, 'GET', '/compliance/export?format=csv')).body).toContain(CANARY);
  });

  it('M3: GET /compliance/trend on another key\'s project has no data', async () => {
    await gateAsA();
    const b = JSON.parse((await as(keyB.key, 'GET', `/compliance/trend?projectName=${CANARY}`)).body);
    expect(b.current).toBeNull();
    const a = JSON.parse((await as(keyA.key, 'GET', `/compliance/trend?projectName=${CANARY}`)).body);
    expect(typeof a.current).toBe('number');
  });

  it('M3: GET /compliance/dashboard renders only the caller\'s records', async () => {
    await gateAsA();
    const b = await as(keyB.key, 'GET', '/compliance/dashboard');
    expect(b.statusCode).toBe(200);
    expect(b.body).not.toContain(CANARY);
    expect((await as(keyA.key, 'GET', '/compliance/dashboard')).body).toContain(CANARY);
  });
});

describe('M4 GET /rate-limits.json shows a key only its own row', () => {
  it('M4: another key\'s keyId, usage and alerts are absent; admin sees every key', async () => {
    getRateLimiter().check(keyA.id, 'free');
    getRateLimiter().check(keyB.id, 'free');
    await getRateLimitAlertStore().fire(keyA.id, 9, 10);
    const b = await as(keyB.key, 'GET', '/rate-limits.json');
    expect(b.statusCode).toBe(200);
    expect(b.body).not.toContain(keyA.id);
    const body = JSON.parse(b.body);
    expect(body.keys.map((k: { keyId: string }) => k.keyId)).toEqual([keyB.id]);
    expect(body.summary.totalKeys).toBe(1);
    expect(body.alerts).toEqual([]);
    expect((await as(ADMIN, 'GET', '/rate-limits.json')).body).toContain(keyA.id);
  });
});

describe('M5 approvals need a stored scan the caller owns', () => {
  it('M5: another key cannot approve or list approvals on A\'s scan', async () => {
    const scanA = getScanStore().record(keyA.id, 'A scan', {});
    expect((await as(keyA.key, 'POST', `/scans/${scanA.id}/approve`, { note: CANARY })).statusCode).toBe(201);
    expect((await as(keyB.key, 'POST', `/scans/${scanA.id}/approve`, {})).statusCode).toBe(404);
    const list = await as(keyB.key, 'GET', `/scans/${scanA.id}/approvals`);
    expect(list.statusCode).toBe(404);
    expect(list.body).not.toContain(keyA.id);
    expect(getApprovalStore().getByScanId(scanA.id).map((e) => e.approver)).toEqual([keyA.id]);
    expect((await as(ADMIN, 'GET', `/scans/${scanA.id}/approvals`)).body).toContain(CANARY);
  });

  it('M5: approving a scan id that does not exist is 404', async () => {
    expect((await as(keyA.key, 'POST', '/scans/undefined/approve', {})).statusCode).toBe(404);
    expect((await as(ADMIN, 'POST', '/scans/undefined/approve', {})).statusCode).toBe(404);
    expect(getApprovalStore().getAll()).toEqual([]);
  });
});

describe('M6 notification history filters are admin-only', () => {
  it('M6: a non-admin key cannot filter by tenant or by another key', async () => {
    expect((await as(keyB.key, 'GET', '/notifications/history?tenantId=t-1')).statusCode).toBe(403);
    expect((await as(keyB.key, 'GET', `/notifications/history?keyId=${keyA.id}`)).statusCode).toBe(403);
    expect((await as(keyB.key, 'GET', '/notifications/history')).statusCode).toBe(200);
    expect((await as(ADMIN, 'GET', '/notifications/history?tenantId=t-1')).statusCode).toBe(200);
  });
});

describe('objects stored before owners were recorded are admin-only', () => {
  it('a template with no owner: admin lists, deletes and uses it; a key gets 404', async () => {
    const t = getTemplateStore().create(`legacy ${CANARY}`, { provider: 'mock' });
    expect((await as(keyA.key, 'GET', '/templates')).body).not.toContain(CANARY);
    expect((await as(keyA.key, 'POST', `/scan/template/${t.id}`, { text: 'x claim.' })).statusCode).toBe(404);
    expect((await as(keyA.key, 'DELETE', `/templates/${t.id}`)).statusCode).toBe(404);
    expect((await as(ADMIN, 'GET', '/templates')).body).toContain(CANARY);
    expect((await as(ADMIN, 'DELETE', `/templates/${t.id}`)).statusCode).toBe(204);
  });

  it('a compliance record with no owner: admin sees it; a key does not', async () => {
    getComplianceHistoryStore().record({
      projectName: CANARY, scanId: 's-legacy', complianceScore: 80, pass: true,
      overallRisk: 'low', nonCompliantCount: 0, totalArticles: 3, threshold: 70,
    });
    expect(JSON.parse((await as(keyA.key, 'GET', '/compliance/history')).body).count).toBe(0);
    expect(JSON.parse((await as(keyA.key, 'GET', `/compliance/trend?projectName=${CANARY}`)).body).current).toBeNull();
    expect(JSON.parse((await as(ADMIN, 'GET', '/compliance/history')).body).count).toBe(1);
  });

  it('a queue item with no owner: admin reads it; a key gets 404', async () => {
    const item = getScanQueue().enqueue(undefined as unknown as string, 2, `legacy ${CANARY}`, 'mock');
    expect((await as(keyA.key, 'GET', `/queue/scans/${item.id}`)).statusCode).toBe(404);
    expect((await as(keyA.key, 'DELETE', `/queue/scans/${item.id}`)).statusCode).toBe(404);
    expect((await as(ADMIN, 'GET', `/queue/scans/${item.id}`)).body).toContain(CANARY);
  });

  it('a stored scan with no owner: admin approves it; a key gets 404', async () => {
    const legacy = getScanStore().record(undefined as unknown as string, 'legacy scan', {});
    expect((await as(keyA.key, 'POST', `/scans/${legacy.id}/approve`, {})).statusCode).toBe(404);
    expect((await as(ADMIN, 'POST', `/scans/${legacy.id}/approve`, {})).statusCode).toBe(201);
  });
});
