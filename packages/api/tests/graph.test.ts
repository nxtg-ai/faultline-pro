import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetScanStore, getScanStore } from '../src/store/scans.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'Test',
    provider: 'mock',
    claims: [],
    verifications: {},
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] },
    ruleFindings: [],
  }),
}));

const MULTI_TYPE_CLAIMS = [
  { id: 'f1', text: 'The Earth is 4.5 billion years old.', type: 'fact', importance: 5 },
  { id: 'f2', text: 'Carbon dating confirms ancient materials.', type: 'fact', importance: 4 },
  { id: 'i1', text: 'Earth formed from solar nebula.', type: 'interpretation', importance: 3 },
  { id: 'o1', text: 'Creationism contradicts this evidence.', type: 'opinion', importance: 2 },
];

const FACTS_ONLY = [
  { id: 'f1', text: 'Water is H2O.', type: 'fact', importance: 5 },
  { id: 'f2', text: 'Hydrogen has one proton.', type: 'fact', importance: 4 },
];

describe('GET /scan/:id/graph', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetScanStore();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 404 for unknown scan id', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/scan/does-not-exist/graph',
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(typeof body.error).toBe('string');
  });

  it('returns 200 with mermaid for known scan', async () => {
    const stored = getScanStore().record('test-key', 'Some claim text', {
      claims: MULTI_TYPE_CLAIMS,
      overallRisk: 'low',
      complianceReport: { riskTier: 'minimal' },
    });

    const res = await server.inject({
      method: 'GET',
      url: `/scan/${stored.id}/graph`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(stored.id);
    expect(typeof body.mermaid).toBe('string');
    expect(body.mermaid.length).toBeGreaterThan(0);
  });

  it('mermaid starts with graph TD', async () => {
    const stored = getScanStore().record('test-key', 'Claim text', {
      claims: MULTI_TYPE_CLAIMS,
    });

    const res = await server.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    const body = JSON.parse(res.body);
    expect(body.mermaid).toMatch(/^graph TD/);
  });

  it('mermaid contains all claim ids as nodes', async () => {
    const stored = getScanStore().record('test-key', 'Text', {
      claims: MULTI_TYPE_CLAIMS,
    });

    const res = await server.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    const body = JSON.parse(res.body);
    for (const claim of MULTI_TYPE_CLAIMS) {
      expect(body.mermaid).toContain(claim.id);
    }
  });

  it('mermaid contains fact→interpretation edge', async () => {
    const stored = getScanStore().record('test-key', 'Text', {
      claims: MULTI_TYPE_CLAIMS,
    });

    const res = await server.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    const body = JSON.parse(res.body);
    // Highest-importance fact (f1) should connect to interpretation i1
    expect(body.mermaid).toContain('f1 --> i1');
  });

  it('mermaid contains interpretation→opinion edge', async () => {
    const stored = getScanStore().record('test-key', 'Text', {
      claims: MULTI_TYPE_CLAIMS,
    });

    const res = await server.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    const body = JSON.parse(res.body);
    // i1 → o1
    expect(body.mermaid).toContain('i1 --> o1');
  });

  it('returns claimCount matching number of claims', async () => {
    const stored = getScanStore().record('test-key', 'Text', {
      claims: MULTI_TYPE_CLAIMS,
    });

    const res = await server.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    const body = JSON.parse(res.body);
    expect(body.claimCount).toBe(4);
  });

  it('returns scannedAt timestamp', async () => {
    const stored = getScanStore().record('test-key', 'Text', {
      claims: MULTI_TYPE_CLAIMS,
    });

    const res = await server.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    const body = JSON.parse(res.body);
    expect(body.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('handles scan with no claims — returns empty graph', async () => {
    const stored = getScanStore().record('test-key', 'Empty', { claims: [] });

    const res = await server.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claimCount).toBe(0);
    expect(body.mermaid).toContain('empty');
  });

  it('handles facts-only scan — no inter-type edges', async () => {
    const stored = getScanStore().record('test-key', 'Facts only', {
      claims: FACTS_ONLY,
    });

    const res = await server.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    const body = JSON.parse(res.body);
    expect(body.claimCount).toBe(2);
    // No interpretation or opinion edges
    expect(body.mermaid).not.toContain('-->');
  });

  it('does not require API key', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const server2 = buildServer();
    const stored = getScanStore().record('test-key', 'Text', { claims: FACTS_ONLY });
    const res = await server2.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    await server2.close();
    expect(res.statusCode).toBe(200);
  });

  it('mermaid labels contain claim type and importance', async () => {
    const stored = getScanStore().record('test-key', 'Text', {
      claims: [{ id: 'f1', text: 'Test claim text.', type: 'fact', importance: 5 }],
    });

    const res = await server.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    const body = JSON.parse(res.body);
    expect(body.mermaid).toContain('fact');
    expect(body.mermaid).toContain('5');
  });

  it('sanitizes XSS in claim text for Mermaid labels', async () => {
    const stored = getScanStore().record('test-key', 'XSS test', {
      claims: [
        { id: 'x1', text: '"><script>alert(1)</script>', type: 'fact', importance: 3 },
        { id: 'x2', text: 'Normal claim ]-->|inject| other', type: 'fact', importance: 2 },
      ],
    });

    const res = await server.inject({ method: 'GET', url: `/scan/${stored.id}/graph` });
    const body = JSON.parse(res.body);
    expect(body.mermaid).not.toContain('<script>');
    expect(body.mermaid).not.toContain('</script>');
    expect(body.mermaid).not.toContain(']-->');
    expect(body.mermaid).not.toMatch(/<[a-z]/i);
  });

  it('getById returns undefined for unknown id', async () => {
    const { getScanStore: getSS } = await import('../src/store/scans.js');
    const result = getSS().getById('nonexistent');
    expect(result).toBeUndefined();
  });

  it('getById returns stored scan by id', async () => {
    const { getScanStore: getSS } = await import('../src/store/scans.js');
    const stored = getSS().record('k', 't', { claims: [] });
    const found = getSS().getById(stored.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(stored.id);
  });
});
