// Validates: claim meter and usage-record contract (issued non-admin keys are metered by default)
//
// Every path that issues a key (POST /keys, POST /orgs/:id/keys, GraphQL
// createKey) gives a non-admin key metered: true and claimCap 1000 unless the
// request says otherwise. Admin keys are never metered by default. A non-admin
// key's claimCap is an integer from 100 to 10,000 on create and on PATCH.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getOrgStore, resetOrgStore } from '../src/store/orgs.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import {
  DEFAULT_CLAIM_CAP, MAX_CLAIM_CAP, MIN_CLAIM_CAP, issuedKeyBilling, claimCapInBounds,
} from '../src/lib/key-issuance.js';

// A fake server key, built at runtime so no key-shaped literal sits in the source.
const SERVER_KEY = ['metered', 'default', 'server', 'key', String(0x5eed)].join('-');

let saved: Record<string, string | undefined>;
let app: FastifyInstance;

beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

beforeEach(async () => {
  saved = { FAULTLINE_API_KEY: process.env.FAULTLINE_API_KEY, FAULTLINE_GRAPHQL: process.env.FAULTLINE_GRAPHQL };
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_GRAPHQL = 'on';
  resetKeyStore();
  resetOrgStore();
  resetUsageMeter();
  resetRateLimiter();
  app = buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetKeyStore();
  resetOrgStore();
});

const headers = { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' };
const createKey = (payload: object) => app.inject({ method: 'POST', url: '/keys', headers, payload });
const patchKey = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/keys/${id}`, headers, payload });
const graphql = (query: string) => app.inject({
  method: 'POST', url: '/graphql', headers: { ...headers, authorization: `Bearer ${SERVER_KEY}` }, payload: JSON.stringify({ query }),
});

describe('the numbers', () => {
  it('default 1,000 claims, bounds 100 to 10,000 (10 to 1,000 USD at 0.10 USD a claim)', () => {
    expect(DEFAULT_CLAIM_CAP).toBe(1000);
    expect(MIN_CLAIM_CAP).toBe(100);
    expect(MAX_CLAIM_CAP).toBe(10_000);
    expect(DEFAULT_CLAIM_CAP * 0.1).toBeCloseTo(100);
    expect(MIN_CLAIM_CAP * 0.1).toBeCloseTo(10);
    expect(MAX_CLAIM_CAP * 0.1).toBeCloseTo(1000);
  });

  it('issuedKeyBilling defaults non-admin keys and leaves admin keys alone', () => {
    expect(issuedKeyBilling(undefined)).toEqual({ metered: true, claimCap: 1000 });
    expect(issuedKeyBilling(['scan'], { claimCap: 250 })).toEqual({ metered: true, claimCap: 250 });
    expect(issuedKeyBilling(['scan'], { metered: false })).toEqual({ metered: false });
    expect(issuedKeyBilling(['scan', 'admin'])).toEqual({});
  });

  it('claimCapInBounds holds non-admin keys to 100..10,000 integers and admin keys to nothing', () => {
    expect([99, 100, 10_000, 10_001, 100.5].map((n) => claimCapInBounds(['scan'], n))).toEqual([false, true, true, false, false]);
    expect([0, 99, 10_001].map((n) => claimCapInBounds(['admin'], n))).toEqual([true, true, true]);
  });
});

describe('POST /keys', () => {
  it('issues a non-admin key metered with claimCap 1000 when none is given', async () => {
    const res = await createKey({ name: 'cust', permissions: ['scan'] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ metered: true, claimCap: 1000 });
    const stored = getKeyStore().validateById(res.json().id as string);
    expect(stored).toMatchObject({ metered: true, claimCap: 1000 });
  });

  it('defaults a key with no permissions given (scan) the same way', async () => {
    const res = await createKey({ name: 'cust' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ permissions: ['scan'], metered: true, claimCap: 1000 });
  });

  it('keeps an explicit in-range claimCap, including both bounds', async () => {
    for (const claimCap of [100, 2500, 10_000]) {
      const res = await createKey({ name: 'cust', permissions: ['scan'], claimCap });
      expect(res.statusCode, String(claimCap)).toBe(201);
      expect(res.json()).toMatchObject({ metered: true, claimCap });
    }
  });

  it('refuses 99 and 10,001 with 400 and issues nothing', async () => {
    for (const claimCap of [99, 10_001, 0]) {
      const res = await createKey({ name: 'cust', permissions: ['scan'], claimCap });
      expect(res.statusCode, String(claimCap)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'claim_cap_out_of_range', min: 100, max: 10_000 });
    }
    expect(getKeyStore().list()).toHaveLength(0);
  });

  it('an admin caller may issue a non-admin key with metered: false', async () => {
    const res = await createKey({ name: 'cust', permissions: ['scan'], metered: false });
    expect(res.statusCode).toBe(201);
    expect(res.json().metered).toBe(false);
    expect(res.json().claimCap).toBeUndefined();
  });

  it('an admin key is not metered by default and keeps any claimCap', async () => {
    const plain = await createKey({ name: 'ops', permissions: ['admin'] });
    expect(plain.statusCode).toBe(201);
    expect(plain.json().metered).toBeUndefined();
    expect(plain.json().claimCap).toBeUndefined();
    const zero = await createKey({ name: 'ops', permissions: ['scan', 'admin'], claimCap: 0 });
    expect(zero.statusCode).toBe(201);
    expect(zero.json()).toMatchObject({ claimCap: 0 });
    expect(zero.json().metered).toBeUndefined();
  });
});

describe('PATCH /keys/:id', () => {
  async function issued(): Promise<string> {
    const res = await createKey({ name: 'cust', permissions: ['scan'] });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('changes a non-admin claimCap within bounds', async () => {
    const id = await issued();
    for (const claimCap of [100, 10_000]) {
      const res = await patchKey(id, { claimCap });
      expect(res.statusCode).toBe(200);
      expect(res.json().claimCap).toBe(claimCap);
    }
  });

  it('refuses 99 and 10,001 with 400 and leaves the cap unchanged', async () => {
    const id = await issued();
    for (const claimCap of [99, 10_001]) {
      const res = await patchKey(id, { claimCap });
      expect(res.statusCode, String(claimCap)).toBe(400);
      expect(res.json().error).toBe('claim_cap_out_of_range');
    }
    expect(getKeyStore().validateById(id)?.claimCap).toBe(1000);
  });

  it('refuses to clear the cap of a metered non-admin key', async () => {
    const id = await issued();
    const res = await patchKey(id, { claimCap: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('claim_cap_required');
    expect(getKeyStore().validateById(id)).toMatchObject({ metered: true, claimCap: 1000 });
  });

  it('refuses to clear the cap while re-scoping an admin key down to a metered non-admin key', async () => {
    const admin = getKeyStore().create('ops', ['admin'], undefined, { metered: true, claimCap: 0 });
    const res = await patchKey(admin.id, { permissions: ['scan'], claimCap: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('claim_cap_required');
  });

  it('an admin key may still have its cap cleared or set to 0', async () => {
    const admin = getKeyStore().create('ops', ['admin'], undefined, { claimCap: 50 });
    expect((await patchKey(admin.id, { claimCap: 0 })).json().claimCap).toBe(0);
    const cleared = await patchKey(admin.id, { claimCap: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().claimCap).toBeUndefined();
  });

  it('an unmetered non-admin key may have its cap cleared', async () => {
    const res = await createKey({ name: 'cust', permissions: ['scan'], metered: false, claimCap: 500 });
    const cleared = await patchKey(res.json().id as string, { claimCap: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().claimCap).toBeUndefined();
  });

  it('an unknown key is still 404', async () => {
    expect((await patchKey('no-such-key', { claimCap: 500 })).statusCode).toBe(404);
  });
});

describe('PATCH /keys/:id checks the key as it will be after the patch', () => {
  it('an admin key with an out-of-range cap re-scoped to non-admin is refused and left unchanged', async () => {
    for (const claimCap of [10_001, 0]) {
      const admin = await createKey({ name: 'ops', permissions: ['admin'], metered: true, claimCap });
      expect(admin.statusCode, String(claimCap)).toBe(201);
      const id = admin.json().id as string;
      const res = await patchKey(id, { permissions: ['scan'] });
      expect(res.statusCode, String(claimCap)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'claim_cap_out_of_range', min: 100, max: 10_000 });
      expect(getKeyStore().validateById(id)).toMatchObject({ permissions: ['admin'], metered: true, claimCap });
    }
  });

  it('a default admin key re-scoped to non-admin becomes metered at claimCap 1000', async () => {
    const admin = await createKey({ name: 'ops', permissions: ['admin'] });
    expect(admin.statusCode).toBe(201);
    const id = admin.json().id as string;
    expect(getKeyStore().validateById(id)?.metered).toBeUndefined();
    const res = await patchKey(id, { permissions: ['scan'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ permissions: ['scan'], metered: true, claimCap: 1000 });
    expect(getKeyStore().validateById(id)).toMatchObject({ permissions: ['scan'], metered: true, claimCap: 1000 });
  });

  it('an admin key that was explicitly unmetered is metered when re-scoped to non-admin', async () => {
    const admin = await createKey({ name: 'ops', permissions: ['admin'], metered: false });
    const id = admin.json().id as string;
    const res = await patchKey(id, { permissions: ['scan'] });
    expect(res.statusCode).toBe(200);
    expect(getKeyStore().validateById(id)).toMatchObject({ metered: true, claimCap: 1000 });
  });

  it('a re-scope that also sets an in-range cap keeps that cap', async () => {
    const admin = await createKey({ name: 'ops', permissions: ['admin'], metered: true, claimCap: 0 });
    const id = admin.json().id as string;
    const res = await patchKey(id, { permissions: ['scan'], claimCap: 2500 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ permissions: ['scan'], metered: true, claimCap: 2500 });
    expect(getKeyStore().validateById(id)).toMatchObject({ metered: true, claimCap: 2500 });
  });

  it('a re-scope that sets metered: false is left unmetered with no default cap', async () => {
    const admin = await createKey({ name: 'ops', permissions: ['admin'] });
    const id = admin.json().id as string;
    const res = await patchKey(id, { permissions: ['scan'], metered: false });
    expect(res.statusCode).toBe(200);
    const stored = getKeyStore().validateById(id);
    expect(stored?.metered).toBe(false);
    expect(stored?.claimCap).toBeUndefined();
  });

  it('turning the meter on for an unmetered scan key needs a cap in the same patch', async () => {
    const created = await createKey({ name: 'cust', permissions: ['scan'], metered: false });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const refused = await patchKey(id, { metered: true });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('claim_cap_required');
    const unchanged = getKeyStore().validateById(id);
    expect(unchanged?.metered).toBe(false);
    expect(unchanged?.claimCap).toBeUndefined();
    const accepted = await patchKey(id, { metered: true, claimCap: 500 });
    expect(accepted.statusCode).toBe(200);
    expect(getKeyStore().validateById(id)).toMatchObject({ metered: true, claimCap: 500 });
  });

  it('a non-admin key PATCHed to admin keeps its fields and takes any cap', async () => {
    const id = (await createKey({ name: 'cust', permissions: ['scan'] })).json().id as string;
    const res = await patchKey(id, { permissions: ['admin'], claimCap: 0 });
    expect(res.statusCode).toBe(200);
    expect(getKeyStore().validateById(id)).toMatchObject({ permissions: ['admin'], metered: true, claimCap: 0 });
  });
});

describe('every bad cap on a non-admin key is claim_cap_out_of_range', () => {
  const BAD_CAPS: unknown[] = [-1, 100.5, 100_000_001, '100'];

  it('on POST /keys, and nothing is issued', async () => {
    for (const claimCap of BAD_CAPS) {
      const res = await createKey({ name: 'cust', permissions: ['scan'], claimCap });
      expect(res.statusCode, JSON.stringify(claimCap)).toBe(400);
      expect(res.json(), JSON.stringify(claimCap)).toMatchObject({ error: 'claim_cap_out_of_range', min: 100, max: 10_000 });
      const bare = await createKey({ name: 'cust', claimCap });
      expect(bare.json().error, JSON.stringify(claimCap)).toBe('claim_cap_out_of_range');
    }
    expect(getKeyStore().list()).toHaveLength(0);
  });

  it('on PATCH /keys/:id of a non-admin key, and the key is unchanged', async () => {
    const id = (await createKey({ name: 'cust', permissions: ['scan'] })).json().id as string;
    for (const claimCap of BAD_CAPS) {
      const res = await patchKey(id, { claimCap });
      expect(res.statusCode, JSON.stringify(claimCap)).toBe(400);
      expect(res.json(), JSON.stringify(claimCap)).toMatchObject({ error: 'claim_cap_out_of_range', min: 100, max: 10_000 });
    }
    expect(getKeyStore().validateById(id)).toMatchObject({ permissions: ['scan'], metered: true, claimCap: 1000 });
  });

  it('on PATCH of an admin key re-scoped to non-admin in the same patch, and the key is unchanged', async () => {
    const admin = getKeyStore().create('ops', ['admin'], undefined, { claimCap: 50 });
    for (const claimCap of BAD_CAPS) {
      const res = await patchKey(admin.id, { permissions: ['scan'], claimCap });
      expect(res.statusCode, JSON.stringify(claimCap)).toBe(400);
      expect(res.json().error, JSON.stringify(claimCap)).toBe('claim_cap_out_of_range');
    }
    expect(getKeyStore().validateById(admin.id)).toMatchObject({ permissions: ['admin'], claimCap: 50 });
  });

  it('admin keys keep the schema answer: -1 and 100.5 are a validation error, not claim_cap_out_of_range', async () => {
    for (const claimCap of [-1, 100.5, 100_000_001]) {
      const res = await createKey({ name: 'ops', permissions: ['admin'], claimCap });
      expect(res.statusCode, String(claimCap)).toBe(400);
      expect(res.json().code, String(claimCap)).toBe('FST_ERR_VALIDATION');
    }
    const admin = getKeyStore().create('ops', ['admin'], undefined, { claimCap: 50 });
    const patched = await patchKey(admin.id, { claimCap: -1 });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().code).toBe('FST_ERR_VALIDATION');
    expect(getKeyStore().validateById(admin.id)?.claimCap).toBe(50);
    expect(getKeyStore().list()).toHaveLength(1);
  });
});

describe('a scalar permissions value is read as the schema coerces it', () => {
  it('POST /keys with scalar "scan" or "report" and claimCap "100" is claim_cap_out_of_range, and nothing is issued', async () => {
    for (const permissions of ['scan', 'report']) {
      const res = await createKey({ name: 'x', permissions, claimCap: '100' });
      expect(res.statusCode, permissions).toBe(400);
      expect(res.json(), permissions).toMatchObject({ error: 'claim_cap_out_of_range', min: 100, max: 10_000 });
    }
    expect(getKeyStore().list()).toHaveLength(0);
  });

  it('PATCH of a non-admin key with scalar "scan" or "report" and claimCap "100" is refused and changes nothing', async () => {
    const id = (await createKey({ name: 'cust', permissions: ['scan'] })).json().id as string;
    for (const permissions of ['scan', 'report']) {
      const res = await patchKey(id, { permissions, claimCap: '100' });
      expect(res.statusCode, permissions).toBe(400);
      expect(res.json(), permissions).toMatchObject({ error: 'claim_cap_out_of_range', min: 100, max: 10_000 });
    }
    expect(getKeyStore().validateById(id)).toMatchObject({ permissions: ['scan'], metered: true, claimCap: 1000 });
  });

  it('PATCH demoting an admin key with scalar "scan" or "report" and claimCap "100" is refused and changes nothing', async () => {
    const admin = getKeyStore().create('ops', ['admin'], undefined, { claimCap: 50 });
    for (const permissions of ['scan', 'report']) {
      const res = await patchKey(admin.id, { permissions, claimCap: '100' });
      expect(res.statusCode, permissions).toBe(400);
      expect(res.json(), permissions).toMatchObject({ error: 'claim_cap_out_of_range', min: 100, max: 10_000 });
    }
    const stored = getKeyStore().validateById(admin.id);
    expect(stored).toMatchObject({ permissions: ['admin'], claimCap: 50 });
    expect(stored?.metered).toBeUndefined();
  });

  it('a scalar "admin" keeps today\'s behaviour: the schema coerces the string cap', async () => {
    const res = await createKey({ name: 'ops', permissions: 'admin', claimCap: '100' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ permissions: ['admin'], claimCap: 100 });
    const admin = getKeyStore().create('ops', ['admin'], undefined, { claimCap: 50 });
    const patched = await patchKey(admin.id, { permissions: 'admin', claimCap: '0' });
    expect(patched.statusCode).toBe(200);
    expect(getKeyStore().validateById(admin.id)).toMatchObject({ permissions: ['admin'], claimCap: 0 });
  });
});

describe('a non-admin key keeps any cap it holds in range, metered or not', () => {
  it('demoting an admin key with claimCap 0 and metered: false is refused and leaves the key unchanged', async () => {
    const admin = getKeyStore().create('ops', ['admin'], undefined, { claimCap: 0 });
    const res = await patchKey(admin.id, { permissions: ['scan'], metered: false });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'claim_cap_out_of_range', min: 100, max: 10_000 });
    const stored = getKeyStore().validateById(admin.id);
    expect(stored).toMatchObject({ permissions: ['admin'], claimCap: 0 });
    expect(stored?.metered).toBeUndefined();
  });

  it('the same demotion with claimCap 500 is accepted', async () => {
    const admin = getKeyStore().create('ops', ['admin'], undefined, { claimCap: 0 });
    const res = await patchKey(admin.id, { permissions: ['scan'], metered: false, claimCap: 500 });
    expect(res.statusCode).toBe(200);
    expect(getKeyStore().validateById(admin.id)).toMatchObject({ permissions: ['scan'], metered: false, claimCap: 500 });
  });

  it('the same demotion with claimCap null is accepted and leaves no cap', async () => {
    const admin = getKeyStore().create('ops', ['admin'], undefined, { claimCap: 0 });
    const res = await patchKey(admin.id, { permissions: ['scan'], metered: false, claimCap: null });
    expect(res.statusCode).toBe(200);
    const stored = getKeyStore().validateById(admin.id);
    expect(stored).toMatchObject({ permissions: ['scan'], metered: false });
    expect(stored?.claimCap).toBeUndefined();
  });
});

describe('POST /orgs/:id/keys', () => {
  it('issues a non-admin org key metered with claimCap 1000', async () => {
    const org = getOrgStore().create({ name: 'Metered Org' }, 'admin');
    const res = await app.inject({ method: 'POST', url: `/orgs/${org.id}/keys`, headers, payload: { name: 'CI', permissions: ['scan'] } });
    expect(res.statusCode).toBe(201);
    expect(getKeyStore().validateById(res.json().keyId as string)).toMatchObject({ metered: true, claimCap: 1000 });
  });

  it('an admin org key is not metered', async () => {
    const org = getOrgStore().create({ name: 'Ops Org' }, 'admin');
    const res = await app.inject({ method: 'POST', url: `/orgs/${org.id}/keys`, headers, payload: { name: 'Ops', permissions: ['admin'] } });
    expect(res.statusCode).toBe(201);
    const stored = getKeyStore().validateById(res.json().keyId as string);
    expect(stored?.metered).toBeUndefined();
    expect(stored?.claimCap).toBeUndefined();
  });
});

describe('GraphQL createKey', () => {
  it('issues a non-admin key metered with claimCap 1000', async () => {
    const res = await graphql('mutation { createKey(name: "gql-cust") { id permissions } }');
    expect(res.statusCode).toBe(200);
    const created = res.json().data.createKey as { id: string; permissions: string[] };
    expect(created.permissions).toEqual(['scan']);
    expect(getKeyStore().validateById(created.id)).toMatchObject({ metered: true, claimCap: 1000 });
  });

  it('an admin key is not metered', async () => {
    const res = await graphql('mutation { createKey(name: "gql-ops", permissions: ["admin"]) { id } }');
    expect(res.statusCode).toBe(200);
    const stored = getKeyStore().validateById(res.json().data.createKey.id as string);
    expect(stored).not.toBeNull();
    expect(stored?.metered).toBeUndefined();
    expect(stored?.claimCap).toBeUndefined();
  });
});
