import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import { resetScanStore } from '../src/store/scans.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'The sky is blue.',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'The sky is blue.', type: 'fact', importance: 3 }],
    verifications: {
      c1: { claimId: 'c1', status: 'verified', explanation: 'Observable.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] },
    ruleFindings: [],
  }),
}));

function gqlBody(query: string, variables?: Record<string, unknown>) {
  return JSON.stringify({ query, variables });
}

describe('GraphQL API', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-key';
    resetCache();
    resetScanStore();
    resetKeyStore();
    resetAuditLogger();
    resetUsageMeter();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  // --- Query: scan ---
  describe('Query: scan', () => {
    it('returns a ScanResult for valid text', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ scan(text: "The sky is blue.") { id input provider overallRisk scannedAt claims { id text type importance } complianceReport { riskTier } } }'),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.scan).toBeDefined();
      expect(body.data.scan.input).toBe('The sky is blue.');
      expect(body.data.scan.provider).toBe('mock');
      expect(body.data.scan.overallRisk).toBe('low');
      expect(body.data.scan.claims.length).toBeGreaterThan(0);
      expect(body.data.scan.claims[0].text).toBe('The sky is blue.');
      expect(body.data.scan.complianceReport.riskTier).toBe('minimal');
      expect(body.data.scan.id).toBeTruthy();
      expect(body.data.scan.scannedAt).toBeTruthy();
    });

    it('accepts an optional provider argument', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ scan(text: "Hello", provider: "gemini") { id provider } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.scan).toBeDefined();
    });

    it('records scan in ScanStore', async () => {
      await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ scan(text: "Test claim.") { id } }'),
      });
      // Second query to verify record exists
      const res2 = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ scans { id input } }'),
      });
      const body2 = JSON.parse(res2.body);
      expect(body2.data.scans.length).toBeGreaterThan(0);
      expect(body2.data.scans[0].input).toBe('The sky is blue.');
    });
  });

  // --- Query: scans ---
  describe('Query: scans', () => {
    it('returns empty array when no scans recorded', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ scans { id input } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.scans).toEqual([]);
    });

    it('returns scans after recording', async () => {
      // First do a scan
      await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ scan(text: "A claim.") { id } }'),
      });
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ scans { id input overallRisk } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.scans.length).toBeGreaterThan(0);
      expect(body.data.scans[0].overallRisk).toBe('low');
    });

    it('respects limit argument', async () => {
      // Record 3 scans
      for (let i = 0; i < 3; i++) {
        await server.inject({
          method: 'POST',
          url: '/graphql',
          headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
          payload: gqlBody(`{ scan(text: "Claim ${i}") { id } }`),
        });
      }
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ scans(limit: 2) { id } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.scans.length).toBe(2);
    });
  });

  // --- Query: keys ---
  describe('Query: keys', () => {
    it('returns empty array with no keys', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ keys { id name permissions createdAt } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.keys).toEqual([]);
    });

    it('returns created key', async () => {
      // Create a key via mutation
      await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('mutation { createKey(name: "test-key") { id name } }'),
      });
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ keys { id name permissions } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.keys.length).toBeGreaterThan(0);
      expect(body.data.keys[0].name).toBe('test-key');
    });
  });

  // --- Query: usage ---
  describe('Query: usage', () => {
    it('returns empty array for unknown key', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ usage(keyId: "unknown-key") { date count } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.usage).toEqual([]);
    });
  });

  // --- Query: audit ---
  describe('Query: audit', () => {
    it('returns audit entries', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ audit { timestamp keyId endpoint method statusCode latencyMs } }'),
      });
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.data.audit)).toBe(true);
    });

    it('respects limit argument', async () => {
      // Trigger some audit entries via REST
      for (let i = 0; i < 3; i++) {
        await server.inject({ method: 'GET', url: '/health' });
      }
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ audit(limit: 2) { timestamp } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.audit.length).toBeLessThanOrEqual(2);
    });
  });

  // --- Mutation: createKey ---
  describe('Mutation: createKey', () => {
    it('creates a key with defaults', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('mutation { createKey(name: "my-key") { id name permissions createdAt } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.createKey.name).toBe('my-key');
      expect(body.data.createKey.permissions).toContain('scan');
      expect(body.data.createKey.id).toBeTruthy();
      expect(body.data.createKey.createdAt).toBeTruthy();
    });

    it('creates a key with custom permissions', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('mutation { createKey(name: "admin-key", permissions: ["scan", "admin"]) { permissions } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.createKey.permissions).toContain('admin');
      expect(body.data.createKey.permissions).toContain('scan');
    });
  });

  // --- Mutation: deleteKey ---
  describe('Mutation: deleteKey', () => {
    it('deletes an existing key', async () => {
      const createRes = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('mutation { createKey(name: "to-delete") { id } }'),
      });
      const createBody = JSON.parse(createRes.body);
      const id = createBody.data.createKey.id;

      const deleteRes = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody(`mutation { deleteKey(id: "${id}") }`),
      });
      const deleteBody = JSON.parse(deleteRes.body);
      expect(deleteBody.data.deleteKey).toBe(true);
    });

    it('returns false for non-existent key', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('mutation { deleteKey(id: "does-not-exist") }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.deleteKey).toBe(false);
    });
  });

  // --- Mutation: scanBatch ---
  describe('Mutation: scanBatch', () => {
    it('returns results for all texts', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('mutation { scanBatch(texts: ["Claim A", "Claim B"]) { id input overallRisk } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.scanBatch.length).toBe(2);
      expect(body.data.scanBatch[0].overallRisk).toBe('low');
      expect(body.data.scanBatch[1].overallRisk).toBe('low');
    });

    it('records all batch scans in ScanStore', async () => {
      await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('mutation { scanBatch(texts: ["A", "B", "C"]) { id } }'),
      });
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('{ scans { id } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.scans.length).toBe(3);
    });

    it('accepts provider argument', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', authorization: 'Bearer test-key' },
        payload: gqlBody('mutation { scanBatch(texts: ["Test"], provider: "mock") { id } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.scanBatch.length).toBe(1);
    });
  });

  // --- introspection / schema ---
  describe('GraphQL introspection', () => {
    it('responds to introspection query', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
        payload: gqlBody('{ __schema { queryType { name } } }'),
      });
      const body = JSON.parse(res.body);
      expect(body.data.__schema.queryType.name).toBe('Query');
    });

    it('returns 200 for valid POST to /graphql', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
        payload: gqlBody('{ __typename }'),
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
