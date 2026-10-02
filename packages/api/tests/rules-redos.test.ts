// CodeQL #6 js/regex-injection and #7 js/polynomial-redos in store/rules.ts.
// Every timing test asserts elapsed time explicitly: a synchronous regex hang
// blocks the worker, so a vitest timeout alone cannot fail it promptly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import {
  createEvaluationBudget,
  evaluateRule,
  evaluateRuleDetailed,
  getRuleStore,
  resetRuleStore,
  validateRuleInput,
} from '../src/store/rules.js';
import { MAX_MATCH_TEXT_LENGTH } from '../src/lib/safe-regex.js';

const FAST = { timeout: 5_000 };
const HEADERS = { 'x-api-key': 'admin-secret' };
const EVIL = '(a+)+$';
// (a+)+$ doubles its work per extra 'a': 24 chars took 191 ms on 2026-10-02, so
// 28 is several seconds unguarded and ~0 ms when the guard skips the rule.
const EVIL_INPUT = 'a'.repeat(28) + '!';

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

/** Simulates a rule persisted before the guard: create() itself does not validate. */
function storeUnvalidatedRegexRule(pattern: string) {
  return getRuleStore().create({ name: 'legacy', description: 'd', condition: 'regex_match', params: { pattern } });
}

describe('regex_match guard at creation (CodeQL #6)', () => {
  let server: FastifyInstance;
  beforeEach(() => { resetRuleStore(); process.env.FAULTLINE_API_KEY = 'admin-secret'; server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('validateRuleInput refuses a catastrophic pattern', () => {
    expect(() => validateRuleInput({ name: 'X', description: 'd', condition: 'regex_match', params: { pattern: EVIL } }))
      .toThrow(/ReDoS guard\): nested quantifier/);
  });

  it('POST /rules answers 400 for a catastrophic pattern and stores nothing', async () => {
    const res = await server.inject({
      method: 'POST', url: '/rules', headers: HEADERS,
      payload: { name: 'evil', description: 'd', condition: 'regex_match', params: { pattern: EVIL } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/ReDoS guard/);
    expect(getRuleStore().list()).toHaveLength(0);
  });

  it('POST /rules answers 400 for a pattern over 256 characters', async () => {
    const res = await server.inject({
      method: 'POST', url: '/rules', headers: HEADERS,
      payload: { name: 'long', description: 'd', condition: 'regex_match', params: { pattern: 'a'.repeat(257) } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/longer than 256/);
  });

  it('PATCH /rules/:id answers 400 for a catastrophic pattern and keeps the old one', async () => {
    const rule = getRuleStore().create({ name: 'R', description: 'd', condition: 'regex_match', params: { pattern: '\\bbest\\b' } });
    const res = await server.inject({
      method: 'PATCH', url: `/rules/${rule.id}`, headers: HEADERS, payload: { params: { pattern: EVIL } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/ReDoS guard/);
    expect(getRuleStore().get(rule.id)!.params.pattern).toBe('\\bbest\\b');
  });

  it('PATCH /rules/:id answers 400 for an invalid severity', async () => {
    const rule = getRuleStore().create({ name: 'R', description: 'd', condition: 'missing_source' });
    const res = await server.inject({
      method: 'PATCH', url: `/rules/${rule.id}`, headers: HEADERS, payload: { severity: 'critical' },
    });
    expect(res.statusCode).toBe(400);
    expect(getRuleStore().get(rule.id)!.severity).toBe('warning');
  });

  it('a normal pattern is still created and still matches', async () => {
    const created = await server.inject({
      method: 'POST', url: '/rules', headers: HEADERS,
      payload: { name: 'sup', description: 'd', condition: 'regex_match', params: { pattern: '\\b(best|largest|first.ever)\\b' } },
    });
    expect(created.statusCode).toBe(201);
    const { id } = JSON.parse(created.body);
    const res = await server.inject({
      method: 'POST', url: `/rules/${id}/test`, headers: HEADERS,
      payload: { claims: [{ text: 'The BEST product ever' }, { text: 'An ordinary product' }] },
    });
    const body = JSON.parse(res.body);
    expect(body.matched).toBe(1);
    expect(body.violations[0].claimIndex).toBe(0);
    expect(body.skipped).toEqual([]);
  });
});

describe('regex_match guard at evaluation, for rules stored before the fix', () => {
  let server: FastifyInstance;
  beforeEach(() => { resetRuleStore(); process.env.FAULTLINE_API_KEY = 'admin-secret'; server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('skips and records a stored catastrophic pattern instead of running it', FAST, () => {
    const rule = storeUnvalidatedRegexRule(EVIL);
    const { result, ms } = timed(() => evaluateRuleDetailed(rule, [{ text: EVIL_INPUT }]));
    expect(ms).toBeLessThan(500);
    expect(result.violations).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ ruleId: rule.id, ruleName: 'legacy' });
    expect(result.skipped[0].reason).toMatch(/pattern refused: nested quantifier/);
  });

  it('evaluateRule (violations only) does not hang on a stored catastrophic pattern', FAST, () => {
    const rule = storeUnvalidatedRegexRule(EVIL);
    const { result, ms } = timed(() => evaluateRule(rule, [{ text: EVIL_INPUT }]));
    expect(ms).toBeLessThan(500);
    expect(result).toEqual([]);
  });

  it('POST /rules/apply returns promptly and lists the skipped rule', FAST, async () => {
    const evil = storeUnvalidatedRegexRule(EVIL);
    getRuleStore().create({ name: 'kw', description: 'd', condition: 'contains_keyword', params: { keywords: ['aaa'] } });
    const start = performance.now();
    const res = await server.inject({
      method: 'POST', url: '/rules/apply', headers: HEADERS, payload: { claims: [{ text: EVIL_INPUT }] },
    });
    expect(performance.now() - start).toBeLessThan(1_000);
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.skipped.map((s: { ruleId: string }) => s.ruleId)).toEqual([evil.id]);
    expect(body.summary.total).toBe(1); // the keyword rule still ran
  });

  it('stops regex rules once the shared evaluation budget is spent', () => {
    const rule = getRuleStore().create({ name: 'R', description: 'd', condition: 'regex_match', params: { pattern: 'a' } });
    const result = evaluateRuleDetailed(rule, [{ text: 'a' }, { text: 'a' }], createEvaluationBudget(-1));
    expect(result.violations).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/budget exhausted at claim 0 of 2/);
  });

  it('a fresh budget evaluates every claim', () => {
    const rule = getRuleStore().create({ name: 'R', description: 'd', condition: 'regex_match', params: { pattern: 'a' } });
    const result = evaluateRuleDetailed(rule, [{ text: 'a' }, { text: 'a' }], createEvaluationBudget());
    expect(result.violations).toHaveLength(2);
    expect(result.skipped).toEqual([]);
  });
});

describe('bounded regex input (CodeQL #7 and the #6 text cap)', () => {
  beforeEach(() => resetRuleStore());

  const dateRule = () => getRuleStore().create({ name: 'D', description: 'd', condition: 'missing_date_citation' });

  it('missing_date_citation is fast on a long run of digits', FAST, () => {
    // The original /\d+%|\d+\s*(...)/ took 4.6 s on 50,000 digits (2026-10-02).
    const { result, ms } = timed(() => evaluateRule(dateRule(), [{ text: '1'.repeat(60_000) }]));
    expect(ms).toBeLessThan(1_000);
    expect(result).toEqual([]);
  });

  it('missing_date_citation still fires on a statistic without a date, and not with one', () => {
    const rule = dateRule();
    expect(evaluateRule(rule, [{ text: 'Revenue grew 40% last quarter.' }])).toHaveLength(1);
    expect(evaluateRule(rule, [{ text: 'GDP is 5 billion dollars.' }])).toHaveLength(1);
    expect(evaluateRule(rule, [{ text: 'Revenue grew 40% in 2025.' }])).toEqual([]);
  });

  it('missing_date_citation sees only the first MAX_MATCH_TEXT_LENGTH characters', () => {
    const text = ' '.repeat(MAX_MATCH_TEXT_LENGTH) + 'Revenue grew 40%.';
    expect(evaluateRule(dateRule(), [{ text }])).toEqual([]);
  });

  it('a user pattern with one unbounded quantifier is fast on long text', FAST, () => {
    const rule = getRuleStore().create({ name: 'U', description: 'd', condition: 'regex_match', params: { pattern: '\\d+x' } });
    const { result, ms } = timed(() => evaluateRule(rule, [{ text: '1'.repeat(60_000) }]));
    expect(ms).toBeLessThan(1_000);
    expect(result).toEqual([]);
  });

  it('a user pattern sees only the first MAX_MATCH_TEXT_LENGTH characters', () => {
    const rule = getRuleStore().create({ name: 'T', description: 'd', condition: 'regex_match', params: { pattern: 'needle' } });
    const late = 'x'.repeat(MAX_MATCH_TEXT_LENGTH) + 'needle';
    const early = 'x'.repeat(MAX_MATCH_TEXT_LENGTH - 6) + 'needle';
    expect(evaluateRule(rule, [{ text: late }])).toEqual([]);
    expect(evaluateRule(rule, [{ text: early }])).toHaveLength(1);
  });
});
