/**
 * Custom rules live in one store that serves every API key. Each key may only
 * see, change, delete, test or apply its own rules; another key's rule reads as
 * 404 so ids cannot be probed. Validates: GoPMO 1.18.7.3.6 (security evidence,
 * broken access control found 2026-10-02 alongside CodeQL #6).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getRuleStore, resetRuleStore } from '../src/store/rules.js';

const RULE = {
  name: 'No percentages',
  description: 'flags percent claims',
  condition: 'contains_keyword',
  params: { keywords: ['percent'] },
  severity: 'error',
};
const CLAIMS = [{ text: 'Ninety percent of users agree.', status: 'supported' }];

let server: FastifyInstance;
let keyA: string;
let keyB: string;

function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, key: string, payload?: InjectOptions['payload']) {
  return server.inject({
    method, url,
    headers: { 'x-api-key': key, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

beforeEach(() => {
  process.env.FAULTLINE_API_KEY = 'admin-secret';
  resetKeyStore();
  resetRuleStore();
  keyA = getKeyStore().create('Tenant A', ['scan']).key;
  keyB = getKeyStore().create('Tenant B', ['scan']).key;
  server = buildServer();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

async function createAsA(): Promise<string> {
  const res = await call('POST', '/rules', keyA, RULE);
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe('custom rules are scoped to the key that created them', () => {
  it('RT-01 list: B sees none of A\'s rules, A sees its own', async () => {
    const id = await createAsA();
    const b = await call('GET', '/rules', keyB);
    expect(b.statusCode).toBe(200);
    expect(b.json().total).toBe(0);
    const a = await call('GET', '/rules', keyA);
    expect(a.json().rules.map((r: { id: string }) => r.id)).toEqual([id]);
  });

  it('RT-02 get: B gets 404 for A\'s rule id', async () => {
    const id = await createAsA();
    expect((await call('GET', `/rules/${id}`, keyB)).statusCode).toBe(404);
    expect((await call('GET', `/rules/${id}`, keyA)).statusCode).toBe(200);
  });

  it('RT-03 patch: B cannot change A\'s rule, and the rule is unchanged', async () => {
    const id = await createAsA();
    const res = await call('PATCH', `/rules/${id}`, keyB, { enabled: false, name: 'hijacked' });
    expect(res.statusCode).toBe(404);
    const rule = getRuleStore().get(id)!;
    expect(rule.enabled).toBe(true);
    expect(rule.name).toBe('No percentages');
  });

  it('RT-04 delete: B cannot delete A\'s rule; A can', async () => {
    const id = await createAsA();
    expect((await call('DELETE', `/rules/${id}`, keyB)).statusCode).toBe(404);
    expect(getRuleStore().get(id)).toBeDefined();
    expect((await call('DELETE', `/rules/${id}`, keyA)).statusCode).toBe(204);
    expect(getRuleStore().get(id)).toBeUndefined();
  });

  it('RT-05 test: B cannot run A\'s rule by id', async () => {
    const id = await createAsA();
    expect((await call('POST', `/rules/${id}/test`, keyB, { claims: CLAIMS })).statusCode).toBe(404);
    expect((await call('POST', `/rules/${id}/test`, keyA, { claims: CLAIMS })).statusCode).toBe(200);
  });

  it('RT-06 apply: A\'s rules fire for A and never for B', async () => {
    await createAsA();
    const a = await call('POST', '/rules/apply', keyA, { claims: CLAIMS });
    expect(a.statusCode).toBe(200);
    expect(a.json().violations.length).toBeGreaterThan(0);
    const b = await call('POST', '/rules/apply', keyB, { claims: CLAIMS });
    expect(b.statusCode).toBe(200);
    expect(b.json().violations).toHaveLength(0);
  });
});
