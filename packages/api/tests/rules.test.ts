import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getRuleStore,
  resetRuleStore,
  validateRuleInput,
  evaluateRule,
} from '../src/store/rules.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetRuleStore();
  process.env.FAULTLINE_API_KEY = 'admin-secret';
}

// ── validateRuleInput ─────────────────────────────────────────────────────────

describe('validateRuleInput', () => {
  it('accepts valid contains_keyword rule', () => {
    const r = validateRuleInput({
      name: 'Revenue check', description: 'Check for revenue claims',
      condition: 'contains_keyword', params: { keywords: ['revenue'] },
    });
    expect(r.name).toBe('Revenue check');
    expect(r.condition).toBe('contains_keyword');
    expect(r.severity).toBe('warning'); // default
    expect(r.enabled).toBe(true);       // default
  });

  it('rejects missing name', () => {
    expect(() => validateRuleInput({ description: 'd', condition: 'missing_source' }))
      .toThrow('name');
  });

  it('rejects invalid condition', () => {
    expect(() => validateRuleInput({ name: 'X', description: 'd', condition: 'bad_cond' }))
      .toThrow('condition');
  });

  it('rejects invalid severity', () => {
    expect(() => validateRuleInput({ name: 'X', description: 'd', condition: 'missing_source', severity: 'critical' }))
      .toThrow('severity');
  });

  it('rejects contains_keyword without keywords', () => {
    expect(() => validateRuleInput({ name: 'X', description: 'd', condition: 'contains_keyword' }))
      .toThrow('keywords');
  });

  it('rejects regex_match with invalid regex', () => {
    expect(() => validateRuleInput({
      name: 'X', description: 'd', condition: 'regex_match', params: { pattern: '[invalid' },
    })).toThrow('valid regex');
  });

  it('accepts regex_match with valid pattern', () => {
    const r = validateRuleInput({ name: 'X', description: 'd', condition: 'regex_match', params: { pattern: '\\bfoo\\b' } });
    expect(r.condition).toBe('regex_match');
  });
});

// ── evaluateRule ──────────────────────────────────────────────────────────────

describe('evaluateRule', () => {
  const baseRule = {
    id: 'r1', createdAt: '', updatedAt: '',
    name: 'Test', description: 'Test rule', severity: 'warning' as const, enabled: true,
  };

  it('returns empty array when rule is disabled', () => {
    const rule = { ...baseRule, condition: 'missing_source' as const, params: {}, enabled: false };
    const claims = [{ text: 'Some claim', sources: [] }];
    expect(evaluateRule(rule, claims)).toHaveLength(0);
  });

  it('contains_keyword: matches when keyword present', () => {
    const rule = { ...baseRule, condition: 'contains_keyword' as const, params: { keywords: ['revenue growth'] } };
    const violations = evaluateRule(rule, [{ text: 'Revenue growth was strong last year.' }]);
    expect(violations).toHaveLength(1);
    expect(violations[0].claimIndex).toBe(0);
  });

  it('contains_keyword: no match when keyword absent', () => {
    const rule = { ...baseRule, condition: 'contains_keyword' as const, params: { keywords: ['revenue growth'] } };
    expect(evaluateRule(rule, [{ text: 'The market expanded.' }])).toHaveLength(0);
  });

  it('missing_source: fires on claim with no sources', () => {
    const rule = { ...baseRule, condition: 'missing_source' as const, params: {} };
    expect(evaluateRule(rule, [{ text: 'Claim', sources: [] }])).toHaveLength(1);
  });

  it('missing_source: does not fire when sources present', () => {
    const rule = { ...baseRule, condition: 'missing_source' as const, params: {} };
    expect(evaluateRule(rule, [{ text: 'Claim', sources: ['https://example.com'] }])).toHaveLength(0);
  });

  it('missing_date_citation: fires on undated statistical claim', () => {
    const rule = { ...baseRule, condition: 'missing_date_citation' as const, params: {} };
    const violations = evaluateRule(rule, [{ text: 'Revenue grew 47% with no date mentioned.' }]);
    expect(violations).toHaveLength(1);
  });

  it('missing_date_citation: no fire when year present', () => {
    const rule = { ...baseRule, condition: 'missing_date_citation' as const, params: {} };
    expect(evaluateRule(rule, [{ text: 'Revenue grew 47% in 2023.' }])).toHaveLength(0);
  });

  it('claim_type: fires when type matches', () => {
    const rule = { ...baseRule, condition: 'claim_type' as const, params: { types: ['causal'] } };
    expect(evaluateRule(rule, [{ text: 'X caused Y', type: 'causal' }])).toHaveLength(1);
  });

  it('claim_type: no fire when type does not match', () => {
    const rule = { ...baseRule, condition: 'claim_type' as const, params: { types: ['causal'] } };
    expect(evaluateRule(rule, [{ text: 'X is Y', type: 'factual' }])).toHaveLength(0);
  });

  it('regex_match: fires when pattern matches', () => {
    const rule = { ...baseRule, condition: 'regex_match' as const, params: { pattern: '\\bbest\\b' } };
    expect(evaluateRule(rule, [{ text: 'This is the best product.' }])).toHaveLength(1);
  });

  it('regex_match: no fire when pattern does not match', () => {
    const rule = { ...baseRule, condition: 'regex_match' as const, params: { pattern: '\\bbest\\b' } };
    expect(evaluateRule(rule, [{ text: 'This is a good product.' }])).toHaveLength(0);
  });

  it('multiple claims — only violating ones appear', () => {
    const rule = { ...baseRule, condition: 'contains_keyword' as const, params: { keywords: ['revenue'] } };
    const violations = evaluateRule(rule, [
      { text: 'Revenue was up.' },
      { text: 'Market grew.' },
      { text: 'Revenue fell.' },
    ]);
    expect(violations).toHaveLength(2);
    expect(violations[0].claimIndex).toBe(0);
    expect(violations[1].claimIndex).toBe(2);
  });
});

// ── RuleStore.applyAll ────────────────────────────────────────────────────────

describe('RuleStore.applyAll', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('returns zero violations on empty store', () => {
    const { violations, summary } = getRuleStore().applyAll([{ text: 'Any claim.' }]);
    expect(violations).toHaveLength(0);
    expect(summary.total).toBe(0);
  });

  it('counts by severity in summary', () => {
    getRuleStore().create({
      name: 'E', description: 'd', condition: 'contains_keyword',
      params: { keywords: ['revenue'] }, severity: 'error',
    });
    getRuleStore().create({
      name: 'W', description: 'd', condition: 'contains_keyword',
      params: { keywords: ['revenue'] }, severity: 'warning',
    });
    const { summary } = getRuleStore().applyAll([{ text: 'Revenue up.' }]);
    expect(summary.error).toBe(1);
    expect(summary.warning).toBe(1);
    expect(summary.total).toBe(2);
  });
});

// ── HTTP: POST /rules ─────────────────────────────────────────────────────────

describe('POST /rules', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 403/401 without auth', async () => {
    const res = await server.inject({
      method: 'POST', url: '/rules',
      payload: { name: 'X', description: 'd', condition: 'missing_source' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('returns 201 with created rule', async () => {
    const res = await server.inject({
      method: 'POST', url: '/rules',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { name: 'No source', description: 'Require sources', condition: 'missing_source' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.name).toBe('No source');
    expect(body.condition).toBe('missing_source');
  });

  it('returns 400 for invalid condition', async () => {
    const res = await server.inject({
      method: 'POST', url: '/rules',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { name: 'X', description: 'd', condition: 'bad_condition' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── HTTP: GET /rules ──────────────────────────────────────────────────────────

describe('GET /rules', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns empty list initially', async () => {
    const res = await server.inject({
      method: 'GET', url: '/rules',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
    expect(body.rules).toHaveLength(0);
  });

  it('lists created rules', async () => {
    getRuleStore().create({ name: 'R1', description: 'd', condition: 'missing_source' });
    getRuleStore().create({ name: 'R2', description: 'd', condition: 'missing_source' });
    const res = await server.inject({
      method: 'GET', url: '/rules',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(JSON.parse(res.body).total).toBe(2);
  });
});

// ── HTTP: PATCH /rules/:id ────────────────────────────────────────────────────

describe('PATCH /rules/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'PATCH', url: '/rules/no-such-id',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it('updates enabled field', async () => {
    const rule = getRuleStore().create({ name: 'R', description: 'd', condition: 'missing_source' });
    const res = await server.inject({
      method: 'PATCH', url: `/rules/${rule.id}`,
      headers: { 'x-api-key': 'admin-secret' },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).enabled).toBe(false);
  });
});

// ── HTTP: DELETE /rules/:id ───────────────────────────────────────────────────

describe('DELETE /rules/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'DELETE', url: '/rules/no-such-id',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 204 and removes rule', async () => {
    const rule = getRuleStore().create({ name: 'R', description: 'd', condition: 'missing_source' });
    const res = await server.inject({
      method: 'DELETE', url: `/rules/${rule.id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(204);
    expect(getRuleStore().get(rule.id)).toBeUndefined();
  });
});

// ── HTTP: POST /rules/:id/test ────────────────────────────────────────────────

describe('POST /rules/:id/test', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 404 for unknown rule id', async () => {
    const res = await server.inject({
      method: 'POST', url: '/rules/no-such-id/test',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { claims: [] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns violation count and matched claims', async () => {
    const rule = getRuleStore().create({
      name: 'Revenue', description: 'd', condition: 'contains_keyword',
      params: { keywords: ['revenue'] },
    });
    const res = await server.inject({
      method: 'POST', url: `/rules/${rule.id}/test`,
      headers: { 'x-api-key': 'admin-secret' },
      payload: { claims: [
        { text: 'Revenue grew 20%.' },
        { text: 'Customers were happy.' },
      ]},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.matched).toBe(1);
    expect(body.claimCount).toBe(2);
    expect(body.violations).toHaveLength(1);
  });
});

// ── HTTP: POST /rules/apply ───────────────────────────────────────────────────

describe('POST /rules/apply', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns summary and violations for all enabled rules', async () => {
    getRuleStore().create({
      name: 'Keyword check', description: 'd', condition: 'contains_keyword',
      params: { keywords: ['best'] }, severity: 'info',
    });
    const res = await server.inject({
      method: 'POST', url: '/rules/apply',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { claims: [{ text: 'This is the best product.' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.summary.total).toBe(1);
    expect(body.summary.info).toBe(1);
    expect(body.violations).toHaveLength(1);
  });
});

// ── HTTP: GET /rules/examples ─────────────────────────────────────────────────

describe('GET /rules/examples', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/rules/examples' });
    expect(res.statusCode).toBe(200);
  });

  it('includes example rules array', async () => {
    const res = await server.inject({ method: 'GET', url: '/rules/examples' });
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.rules)).toBe(true);
    expect(body.rules.length).toBeGreaterThan(0);
  });
});
