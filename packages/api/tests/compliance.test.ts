/**
 * Compliance Report Generator Tests (D-174)
 *
 * Covers: GET /templates/compliance, POST /templates/compliance,
 * DELETE /templates/compliance/:id, POST /scan/compliance/:template,
 * and ComplianceTemplateStore behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetComplianceTemplateStore } from '../src/store/compliance-templates.js';
import type { FastifyInstance } from 'fastify';

// ── Mock scan ─────────────────────────────────────────────────────────────────

const { scan: mockScan } = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));

// Mock result with medical keywords so healthcare rules trigger
const MOCK_HEALTHCARE_RESULT = {
  input: 'The patient received a diagnosis of hypertension and was prescribed medication.',
  provider: 'mock',
  claims: [
    {
      id: 'c1',
      text: 'The patient received a diagnosis of hypertension.',
      type: 'fact',
      importance: 4,
    },
    {
      id: 'c2',
      text: 'The patient was prescribed medication for treatment.',
      type: 'fact',
      importance: 4,
    },
  ],
  verifications: {
    c1: { claimId: 'c1', status: 'unverified', explanation: 'No medical record access.', sources: [] },
    c2: { claimId: 'c2', status: 'contradicted', explanation: 'Cannot verify prescription.', sources: [] },
  },
  overallRisk: 'high',
  complianceReport: { riskTier: 'high', findings: [] },
  ruleFindings: [],
};

// Mock result with finance keywords
const MOCK_FINANCE_RESULT = {
  input: 'The stock earnings will yield 20% investment returns next quarter.',
  provider: 'mock',
  claims: [
    {
      id: 'c1',
      text: 'The stock earnings will yield 20% investment returns next quarter.',
      type: 'fact',
      importance: 5,
    },
  ],
  verifications: {
    c1: { claimId: 'c1', status: 'unverified', explanation: 'Unsubstantiated projection.', sources: [] },
  },
  overallRisk: 'high',
  complianceReport: { riskTier: 'high', findings: [] },
  ruleFindings: [],
};

// Mock result with education keywords
const MOCK_EDUCATION_RESULT = {
  input: 'Student GPA and academic grades declined this semester.',
  provider: 'mock',
  claims: [
    {
      id: 'c1',
      text: 'Student GPA and academic grades declined this semester.',
      type: 'fact',
      importance: 3,
    },
  ],
  verifications: {
    c1: { claimId: 'c1', status: 'unverified', explanation: 'No transcript access.', sources: [] },
  },
  overallRisk: 'medium',
  complianceReport: { riskTier: 'medium', findings: [] },
  ruleFindings: [],
};

// Mock result with government keywords
const MOCK_GOVERNMENT_RESULT = {
  input: 'According to official statistics, the federal policy mandates regulation compliance.',
  provider: 'mock',
  claims: [
    {
      id: 'c1',
      text: 'According to official statistics, the federal policy mandates regulation compliance.',
      type: 'fact',
      importance: 3,
    },
  ],
  verifications: {
    c1: { claimId: 'c1', status: 'supported', explanation: 'Consistent with public records.', sources: [] },
  },
  overallRisk: 'low',
  complianceReport: { riskTier: 'low', findings: [] },
  ruleFindings: [],
};

const ADMIN = 'test-key';
const JSON_HDR = { 'content-type': 'application/json' };

function authHeaders() {
  return { 'x-api-key': ADMIN, ...JSON_HDR };
}

let server: FastifyInstance;

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = ADMIN;
  resetComplianceTemplateStore();
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

// ── CL1: GET /templates/compliance ───────────────────────────────────────────

describe('GET /templates/compliance', () => {
  it('CL1: returns array with 4 built-in templates', async () => {
    const res = await server.inject({ method: 'GET', url: '/templates/compliance' });
    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(4); // Gate 2
  });

  it('CL2: each template has id, name, industry, regulations, rules fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/templates/compliance' });
    const list = JSON.parse(res.body);
    expect(list.length).toBeGreaterThan(0); // Gate 2
    for (const template of list) {
      expect(template.id).toBeDefined();
      expect(template.name).toBeDefined();
      expect(template.industry).toBeDefined();
      expect(Array.isArray(template.regulations)).toBe(true);
      expect(Array.isArray(template.rules)).toBe(true);
    }
  });

  it('built-in template ids include healthcare, finance, education, government', async () => {
    const res = await server.inject({ method: 'GET', url: '/templates/compliance' });
    const list = JSON.parse(res.body);
    const ids = list.map((t: { id: string }) => t.id);
    expect(ids).toContain('healthcare');
    expect(ids).toContain('finance');
    expect(ids).toContain('education');
    expect(ids).toContain('government');
  });
});

// ── CL3–CL4: POST /scan/compliance/healthcare ─────────────────────────────────

describe('POST /scan/compliance/healthcare', () => {
  it('CL3: returns scanResult + complianceAnalysis', async () => {
    mockScan.mockResolvedValueOnce(MOCK_HEALTHCARE_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance/healthcare',
      headers: authHeaders(),
      body: JSON.stringify({
        text: 'The patient received a diagnosis and was prescribed treatment.',
        provider: 'mock',
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.overallRisk).toBeDefined();
    expect(body.claims).toBeDefined();
    expect(body.complianceAnalysis).toHaveProperty('templateId');
  });

  it('CL4: complianceAnalysis has templateId, templateName, triggeredRules, summary, generatedAt', async () => {
    mockScan.mockResolvedValueOnce(MOCK_HEALTHCARE_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance/healthcare',
      headers: authHeaders(),
      body: JSON.stringify({
        text: 'Patient diagnosis and medical treatment prescribed.',
        provider: 'mock',
      }),
    });
    const body = JSON.parse(res.body);
    const ca = body.complianceAnalysis;
    expect(ca.templateId).toBe('healthcare');
    expect(ca.templateName).toBeDefined();
    expect(Array.isArray(ca.triggeredRules)).toBe(true);
    expect(ca.summary).toBeDefined();
    expect(ca.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── CL5: POST /scan/compliance/finance ────────────────────────────────────────

describe('POST /scan/compliance/finance', () => {
  it('CL5: returns 200 with complianceAnalysis for finance template', async () => {
    mockScan.mockResolvedValueOnce(MOCK_FINANCE_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance/finance',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'Stock earnings and investment returns forecast.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.complianceAnalysis.templateId).toBe('finance');
    expect(body.complianceAnalysis.industry).toBe('Finance');
  });
});

// ── CL6: POST /scan/compliance/education ──────────────────────────────────────

describe('POST /scan/compliance/education', () => {
  it('CL6: returns 200 with complianceAnalysis for education template', async () => {
    mockScan.mockResolvedValueOnce(MOCK_EDUCATION_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance/education',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'Student GPA and academic grades.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.complianceAnalysis.templateId).toBe('education');
    expect(body.complianceAnalysis.industry).toBe('Education');
  });
});

// ── CL7: POST /scan/compliance/government ─────────────────────────────────────

describe('POST /scan/compliance/government', () => {
  it('CL7: returns 200 with complianceAnalysis for government template', async () => {
    mockScan.mockResolvedValueOnce(MOCK_GOVERNMENT_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance/government',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'Federal policy official statistics regulation.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.complianceAnalysis.templateId).toBe('government');
    expect(body.complianceAnalysis.industry).toBe('Government');
  });
});

// ── CL8: Unknown template ─────────────────────────────────────────────────────

describe('POST /scan/compliance/:template — unknown', () => {
  it('CL8: returns 404 for unknown template id', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance/unknown-template-xyz',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'Some text.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toContain('not found');
  });
});

// ── CL9–CL12: Custom template CRUD ───────────────────────────────────────────

describe('POST /templates/compliance — custom template', () => {
  const CUSTOM_BODY = {
    name: 'Retail Compliance',
    industry: 'Retail',
    regulations: ['CCPA', 'PCI DSS'],
    rules: [
      {
        id: 'ret-pricing',
        name: 'Pricing Claims',
        description: 'Claims about product pricing accuracy.',
        claimPatterns: ['price', 'discount', 'sale'],
        severity: 'medium' as const,
      },
    ],
    riskThresholds: { critical: 1, high: 2, medium: 3 },
  };

  it('CL9: admin can create custom template', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/templates/compliance',
      headers: authHeaders(),
      body: JSON.stringify(CUSTOM_BODY),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.name).toBe('Retail Compliance');
    expect(body.custom).toBe(true);
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('CL10: custom template appears in GET /templates/compliance list', async () => {
    await server.inject({
      method: 'POST',
      url: '/templates/compliance',
      headers: authHeaders(),
      body: JSON.stringify(CUSTOM_BODY),
    });

    const res = await server.inject({ method: 'GET', url: '/templates/compliance' });
    const list = JSON.parse(res.body);
    expect(list.length).toBe(5); // 4 built-in + 1 custom — Gate 2
    const custom = list.find((t: { name: string }) => t.name === 'Retail Compliance');
    expect(custom!.custom).toBe(true);
  });

  it('CL11: DELETE /templates/compliance/:id removes custom template', async () => {
    const create = await server.inject({
      method: 'POST',
      url: '/templates/compliance',
      headers: authHeaders(),
      body: JSON.stringify(CUSTOM_BODY),
    });
    const { id } = JSON.parse(create.body);

    const del = await server.inject({
      method: 'DELETE',
      url: `/templates/compliance/${id}`,
      headers: { 'x-api-key': ADMIN },
    });
    expect(del.statusCode).toBe(204);

    const list = await server.inject({ method: 'GET', url: '/templates/compliance' });
    const templates = JSON.parse(list.body);
    expect(templates.length).toBe(4); // back to 4 built-ins — Gate 2
    expect(templates.find((t: { id: string }) => t.id === id)).toBeUndefined();
  });

  it('CL12: cannot DELETE built-in template — returns 400', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/templates/compliance/healthcare',
      headers: { 'x-api-key': ADMIN },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('built-in');
  });
});

// ── CL13: Auth ────────────────────────────────────────────────────────────────

describe('POST /scan/compliance/:template — auth', () => {
  it('CL13: requires api key (401 when missing)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance/healthcare',
      headers: JSON_HDR,
      body: JSON.stringify({ text: 'Test.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── CL14: triggeredRules may be empty ─────────────────────────────────────────

describe('triggeredRules — no pattern match', () => {
  it('CL14: triggeredRules is array and may be empty when no patterns match', async () => {
    mockScan.mockResolvedValueOnce({
      input: 'The weather is nice today.',
      provider: 'mock',
      claims: [{ id: 'c1', text: 'The weather is nice today.', type: 'fact', importance: 1 }],
      verifications: {
        c1: { claimId: 'c1', status: 'supported', explanation: 'Observable.', sources: [] },
      },
      overallRisk: 'low',
      complianceReport: { riskTier: 'minimal', findings: [] },
      ruleFindings: [],
    });

    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance/healthcare',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'The weather is nice today.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.complianceAnalysis.triggeredRules)).toBe(true);
  });
});

// ── CL15: explicit provider ───────────────────────────────────────────────────

describe('POST /scan/compliance with explicit provider', () => {
  it('CL15: passes provider to scan function', async () => {
    mockScan.mockResolvedValueOnce(MOCK_FINANCE_RESULT);
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance/finance',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'Revenue projections for next quarter.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(mockScan).toHaveBeenCalledWith(
      'Revenue projections for next quarter.',
      'mock',
    );
  });
});
