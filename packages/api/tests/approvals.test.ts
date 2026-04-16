// Validates: N-218 (Art. 14 Human Sign-Off Record)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import { resetApprovalStore, getApprovalStore } from '../src/store/approvals.js';
import type { FastifyInstance } from 'fastify';

const SCAN_ID = 'scan-abc-123';

function setup() {
  process.env.FAULTLINE_API_KEY = 'admin-secret';
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetCache();
  resetApprovalStore();
}

function approve(server: FastifyInstance, scanId: string, body: object = {}, key = 'admin-secret') {
  return server.inject({
    method: 'POST',
    url: `/scans/${scanId}/approve`,
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getApprovals(server: FastifyInstance, scanId: string, key = 'admin-secret') {
  return server.inject({
    method: 'GET',
    url: `/scans/${scanId}/approvals`,
    headers: { 'x-api-key': key },
  });
}

// ── Authentication ────────────────────────────────────────────────────────────

describe('POST /scans/:id/approve — authentication', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('AP1. returns 401 without API key', async () => {
    const res = await server.inject({ method: 'POST', url: `/scans/${SCAN_ID}/approve`, headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.statusCode).toBe(401);
  });

  it('AP2. returns 201 with valid key', async () => {
    const res = await approve(server, SCAN_ID);
    expect(res.statusCode).toBe(201);
  });

  it('AP3. scan-only key can approve (not admin-only)', async () => {
    const k = getKeyStore().create('Scan Key', ['scan']);
    const res = await approve(server, SCAN_ID, {}, k.key);
    expect(res.statusCode).toBe(201);
  });
});

// ── Response shape ────────────────────────────────────────────────────────────

describe('POST /scans/:id/approve — response shape', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('AP4. response has id, scanId, approver, timestamp, decision', async () => {
    const body = JSON.parse((await approve(server, SCAN_ID)).body);
    expect(typeof body.id).toBe('string');
    expect(body.scanId).toBe(SCAN_ID);
    expect(typeof body.approver).toBe('string');
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.decision).toBe('string');
  });

  it('AP5. default decision is "approved"', async () => {
    const body = JSON.parse((await approve(server, SCAN_ID)).body);
    expect(body.decision).toBe('approved');
  });

  it('AP6. decision "rejected" is stored correctly', async () => {
    const body = JSON.parse((await approve(server, SCAN_ID, { decision: 'rejected' })).body);
    expect(body.decision).toBe('rejected');
  });

  it('AP7. note is stored when provided', async () => {
    const body = JSON.parse((await approve(server, SCAN_ID, { note: 'LGTM' })).body);
    expect(body.note).toBe('LGTM');
  });

  it('AP8. note is undefined when not provided', async () => {
    const body = JSON.parse((await approve(server, SCAN_ID)).body);
    expect(body.note).toBeUndefined();
  });

  it('AP9. timestamp is an ISO string', async () => {
    const { timestamp } = JSON.parse((await approve(server, SCAN_ID)).body);
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('AP10. approver matches the requesting key identity ("admin")', async () => {
    const { approver } = JSON.parse((await approve(server, SCAN_ID)).body);
    expect(approver).toBe('admin');
  });
});

// ── GET /scans/:id/approvals ──────────────────────────────────────────────────

describe('GET /scans/:id/approvals', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('AP11. returns 401 without API key', async () => {
    const res = await server.inject({ method: 'GET', url: `/scans/${SCAN_ID}/approvals` });
    expect(res.statusCode).toBe(401);
  });

  it('AP12. returns 200 with valid key', async () => {
    const res = await getApprovals(server, SCAN_ID);
    expect(res.statusCode).toBe(200);
  });

  it('AP13. empty → approvals = [], total = 0', async () => {
    const body = JSON.parse((await getApprovals(server, SCAN_ID)).body);
    expect(body.scanId).toBe(SCAN_ID);
    expect(Array.isArray(body.approvals)).toBe(true);
    expect(body.approvals).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('AP14. after one approval → approvals.length = 1, total = 1', async () => {
    await approve(server, SCAN_ID);
    const body = JSON.parse((await getApprovals(server, SCAN_ID)).body);
    expect(body.approvals.length).toBe(1);
    expect(body.total).toBe(1);
  });

  it('AP15. only returns approvals for the requested scanId', async () => {
    await approve(server, SCAN_ID);
    await approve(server, 'other-scan-id');
    const body = JSON.parse((await getApprovals(server, SCAN_ID)).body);
    expect(body.approvals.length).toBe(1);
    expect(body.approvals[0].scanId).toBe(SCAN_ID);
  });

  it('AP16. two approvals for same scan → both returned', async () => {
    await approve(server, SCAN_ID, { note: 'First review' });
    await approve(server, SCAN_ID, { decision: 'rejected', note: 'On second thought' });
    const body = JSON.parse((await getApprovals(server, SCAN_ID)).body);
    expect(body.approvals.length).toBe(2);
    expect(body.total).toBe(2);
  });
});

// ── Store direct ──────────────────────────────────────────────────────────────

describe('ApprovalStore', () => {
  beforeEach(() => { resetApprovalStore(); });

  it('AP17. record() returns entry with auto-generated id', () => {
    const entry = getApprovalStore().record({ scanId: 's1', approver: 'k1', timestamp: new Date().toISOString(), decision: 'approved' });
    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.scanId).toBe('s1');
    expect(entry.decision).toBe('approved');
  });

  it('AP18. getByScanId returns only matching entries', () => {
    getApprovalStore().record({ scanId: 's1', approver: 'k1', timestamp: new Date().toISOString(), decision: 'approved' });
    getApprovalStore().record({ scanId: 's2', approver: 'k1', timestamp: new Date().toISOString(), decision: 'rejected' });
    const results = getApprovalStore().getByScanId('s1');
    expect(results).toHaveLength(1);
    expect(results[0]?.scanId).toBe('s1');
  });

  it('AP19. resetApprovalStore clears all entries', () => {
    getApprovalStore().record({ scanId: 's1', approver: 'k1', timestamp: new Date().toISOString(), decision: 'approved' });
    resetApprovalStore();
    expect(getApprovalStore().getAll()).toHaveLength(0);
  });
});
