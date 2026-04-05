import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getOrgStore, resetOrgStore } from '../src/store/orgs.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetUsageMeter, getUsageMeter } from '../src/store/usage.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetOrgStore();
  resetKeyStore();
  resetUsageMeter();
  process.env.FAULTLINE_API_KEY = 'admin-key';
}

// ── OrgStore unit tests ───────────────────────────────────────────────────────

describe('OrgStore.create', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('creates an org with required fields', () => {
    const org = getOrgStore().create({ name: 'Acme Corp' }, 'k1');
    expect(org.id).toBeTruthy();
    expect(org.name).toBe('Acme Corp');
    expect(org.slug).toBe('acme-corp');
    expect(org.status).toBe('active');
    expect(org.plan).toBe('free');
    expect(org.ownerId).toBe('k1');
  });

  it('auto-adds owner as admin member', () => {
    const org = getOrgStore().create({ name: 'TestOrg' }, 'owner1');
    expect(org.members).toHaveLength(1);
    expect(org.members[0].keyId).toBe('owner1');
    expect(org.members[0].role).toBe('admin');
  });

  it('deduplicates slug with suffix', () => {
    getOrgStore().create({ name: 'Acme' }, 'k1');
    const org2 = getOrgStore().create({ name: 'Acme' }, 'k2');
    expect(org2.slug).toBe('acme-2');
  });

  it('accepts explicit slug', () => {
    const org = getOrgStore().create({ name: 'X', slug: 'my-org' }, 'k1');
    expect(org.slug).toBe('my-org');
  });

  it('throws for empty name', () => {
    expect(() => getOrgStore().create({ name: '   ' }, 'k1')).toThrow('required');
  });
});

describe('OrgStore CRUD', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('get returns org by id', () => {
    const org = getOrgStore().create({ name: 'A' }, 'k1');
    expect(getOrgStore().get(org.id)?.name).toBe('A');
  });

  it('getBySlug returns org', () => {
    getOrgStore().create({ name: 'Slug Test' }, 'k1'); // space → hyphen in slug
    expect(getOrgStore().getBySlug('slug-test')).toMatchObject({ slug: 'slug-test' });
  });

  it('listForKey returns only orgs the key belongs to', () => {
    getOrgStore().create({ name: 'A' }, 'k1');
    getOrgStore().create({ name: 'B' }, 'k2');
    expect(getOrgStore().listForKey('k1')).toHaveLength(1);
  });

  it('update patches fields', () => {
    const org = getOrgStore().create({ name: 'Old' }, 'k1');
    const updated = getOrgStore().update(org.id, { name: 'New', plan: 'pro' });
    expect(updated?.name).toBe('New');
    expect(updated?.plan).toBe('pro');
  });

  it('delete removes org', () => {
    const org = getOrgStore().create({ name: 'Del' }, 'k1');
    getOrgStore().delete(org.id);
    expect(getOrgStore().get(org.id)).toBeUndefined();
  });
});

describe('OrgStore — membership', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('addMember adds analyst', () => {
    const org = getOrgStore().create({ name: 'M' }, 'owner');
    getOrgStore().addMember(org.id, 'analyst1', 'analyst', 'a@example.com');
    expect(getOrgStore().get(org.id)!.members).toHaveLength(2);
  });

  it('getMemberRole returns correct role', () => {
    const org = getOrgStore().create({ name: 'R' }, 'owner');
    getOrgStore().addMember(org.id, 'viewer1', 'viewer');
    expect(getOrgStore().getMemberRole(org.id, 'viewer1')).toBe('viewer');
    expect(getOrgStore().getMemberRole(org.id, 'nobody')).toBeNull();
  });

  it('addMember throws on duplicate', () => {
    const org = getOrgStore().create({ name: 'D' }, 'owner');
    expect(() => getOrgStore().addMember(org.id, 'owner', 'analyst')).toThrow('already belongs');
  });

  it('updateMemberRole changes role', () => {
    const org = getOrgStore().create({ name: 'U' }, 'owner');
    getOrgStore().addMember(org.id, 'user1', 'analyst');
    getOrgStore().updateMemberRole(org.id, 'user1', 'viewer');
    expect(getOrgStore().getMemberRole(org.id, 'user1')).toBe('viewer');
  });

  it('prevents demoting the last admin', () => {
    const org = getOrgStore().create({ name: 'LA' }, 'owner');
    expect(() => getOrgStore().updateMemberRole(org.id, 'owner', 'viewer')).toThrow('last admin');
  });

  it('removeMember works for non-admin', () => {
    const org = getOrgStore().create({ name: 'RM' }, 'owner');
    getOrgStore().addMember(org.id, 'user1', 'viewer');
    getOrgStore().removeMember(org.id, 'user1');
    expect(getOrgStore().getMemberRole(org.id, 'user1')).toBeNull();
  });

  it('prevents removing the last admin', () => {
    const org = getOrgStore().create({ name: 'LA2' }, 'owner');
    expect(() => getOrgStore().removeMember(org.id, 'owner')).toThrow('last admin');
  });
});

describe('OrgStore — invitations', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('createInvite returns a token', () => {
    const org = getOrgStore().create({ name: 'Inv' }, 'owner');
    const invite = getOrgStore().createInvite(org.id, 'user@example.com', 'analyst', 'owner');
    expect(invite.token).toHaveLength(48); // 24 bytes hex = 48 chars
    expect(invite.role).toBe('analyst');
  });

  it('acceptInvite adds the member', () => {
    const org = getOrgStore().create({ name: 'Acc' }, 'owner');
    const invite = getOrgStore().createInvite(org.id, 'u@x.com', 'viewer', 'owner');
    getOrgStore().acceptInvite(invite.token, 'new-member-key');
    expect(getOrgStore().getMemberRole(org.id, 'new-member-key')).toBe('viewer');
  });

  it('acceptInvite throws on double-accept', () => {
    const org = getOrgStore().create({ name: 'DA' }, 'owner');
    const invite = getOrgStore().createInvite(org.id, 'u@x.com', 'analyst', 'owner');
    getOrgStore().acceptInvite(invite.token, 'k1');
    expect(() => getOrgStore().acceptInvite(invite.token, 'k2')).toThrow('already accepted');
  });

  it('acceptInvite throws for unknown token', () => {
    expect(() => getOrgStore().acceptInvite('bad-token', 'k1')).toThrow('not found');
  });
});

describe('OrgStore — scoped keys', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('createOrgKey creates a key and attaches to org', () => {
    const org = getOrgStore().create({ name: 'Keys' }, 'owner');
    const { orgKey, apiKey } = getOrgStore().createOrgKey(org.id, 'CI Key', ['scan'], 'owner');
    expect(apiKey.key).toBeTruthy();
    expect(apiKey.name).toContain('CI Key');
    expect(orgKey.keyId).toBe(apiKey.id);
    expect(getOrgStore().get(org.id)!.keys).toHaveLength(1);
  });

  it('revokeOrgKey removes from org and global store', () => {
    const org = getOrgStore().create({ name: 'Rev' }, 'owner');
    const { apiKey } = getOrgStore().createOrgKey(org.id, 'TmpKey', ['scan'], 'owner');
    getOrgStore().revokeOrgKey(org.id, apiKey.id);
    expect(getOrgStore().get(org.id)!.keys).toHaveLength(0);
  });
});

describe('OrgStore — usage aggregation', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('getUsage returns zero for new org', () => {
    const org = getOrgStore().create({ name: 'Usage' }, 'owner');
    const summary = getOrgStore().getUsage(org.id);
    expect(summary.totalScans).toBe(0);
    expect(summary.byKey).toHaveLength(0);
  });

  it('aggregates usage across member keyIds', () => {
    const org = getOrgStore().create({ name: 'Agg' }, 'owner');
    getOrgStore().addMember(org.id, 'analyst1', 'analyst');
    const today = new Date().toISOString().split('T')[0];
    // Simulate usage meter entries for this month
    getUsageMeter().increment('owner');
    getUsageMeter().increment('owner');
    getUsageMeter().increment('analyst1');
    const month = today.slice(0, 7);
    const summary = getOrgStore().getUsage(org.id, month);
    expect(summary.totalScans).toBe(3);
    expect(summary.byDay[today]).toBe(3);
  });
});

// ── HTTP routes ───────────────────────────────────────────────────────────────

describe('POST /orgs', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('creates an org and returns 201', async () => {
    const res = await server.inject({
      method: 'POST', url: '/orgs',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { name: 'Test Corp', description: 'Our org' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('Test Corp');
    expect(body.slug).toBe('test-corp');
    expect(body.members).toHaveLength(1);
    expect(body.members[0].role).toBe('admin');
  });

  it('returns 400 for missing name', async () => {
    const res = await server.inject({
      method: 'POST', url: '/orgs',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { description: 'No name' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('returns 4xx without auth', async () => {
    const res = await server.inject({
      method: 'POST', url: '/orgs',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /orgs', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns orgs for current key', async () => {
    // POST creates org owned by 'admin' keyId
    await server.inject({
      method: 'POST', url: '/orgs',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { name: 'My Org' },
    });
    const res = await server.inject({
      method: 'GET', url: '/orgs',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.orgs)).toBe(true);
    expect(body.orgs.length).toBeGreaterThan(0);
  });
});

describe('GET /orgs/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 for a member', async () => {
    const org = getOrgStore().create({ name: 'Get' }, 'admin');
    const res = await server.inject({
      method: 'GET', url: '/orgs/' + org.id,
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('Get');
  });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'GET', url: '/orgs/nope',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for non-member', async () => {
    const org = getOrgStore().create({ name: 'Other' }, 'other-key');
    const res = await server.inject({
      method: 'GET', url: '/orgs/' + org.id,
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /orgs/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('updates org name (admin)', async () => {
    const org = getOrgStore().create({ name: 'Old Name' }, 'admin');
    const res = await server.inject({
      method: 'PATCH', url: '/orgs/' + org.id,
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { name: 'New Name', plan: 'pro' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('New Name');
    expect(body.plan).toBe('pro');
  });

  it('returns 403 for non-admin', async () => {
    const org = getOrgStore().create({ name: 'No' }, 'admin');
    getOrgStore().addMember(org.id, 'viewer1', 'viewer');
    // viewer1 is not the env key — they'd need a keystore key, so test 403 via another org
    const org2 = getOrgStore().create({ name: 'O2' }, 'other');
    const res = await server.inject({
      method: 'PATCH', url: '/orgs/' + org2.id,
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { name: 'Hack' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('non-owner admin can update name and description', async () => {
    // Org owned by 'other-owner', with 'admin' (env key) added as admin member
    const org = getOrgStore().create({ name: 'OwnerTest' }, 'other-owner');
    getOrgStore().addMember(org.id, 'admin', 'admin');
    const res = await server.inject({
      method: 'PATCH', url: '/orgs/' + org.id,
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { name: 'Updated Name', description: 'New desc' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('Updated Name');
  });

  it('non-owner admin cannot change plan (403)', async () => {
    const org = getOrgStore().create({ name: 'PlanGuard' }, 'other-owner');
    getOrgStore().addMember(org.id, 'admin', 'admin');
    const res = await server.inject({
      method: 'PATCH', url: '/orgs/' + org.id,
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { plan: 'enterprise' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain('owner');
  });

  it('non-owner admin cannot change status (403)', async () => {
    const org = getOrgStore().create({ name: 'StatusGuard' }, 'other-owner');
    getOrgStore().addMember(org.id, 'admin', 'admin');
    const res = await server.inject({
      method: 'PATCH', url: '/orgs/' + org.id,
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain('owner');
  });

  it('owner can change plan and status', async () => {
    const org = getOrgStore().create({ name: 'OwnerOK' }, 'admin');
    const res = await server.inject({
      method: 'PATCH', url: '/orgs/' + org.id,
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { plan: 'enterprise', status: 'suspended' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.plan).toBe('enterprise');
    expect(body.status).toBe('suspended');
  });
});

describe('DELETE /orgs/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('owner can delete org (204)', async () => {
    const org = getOrgStore().create({ name: 'Del' }, 'admin');
    const res = await server.inject({
      method: 'DELETE', url: '/orgs/' + org.id,
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(204);
    expect(getOrgStore().get(org.id)).toBeUndefined();
  });

  it('non-owner cannot delete (403)', async () => {
    const org = getOrgStore().create({ name: 'NoD' }, 'other');
    const res = await server.inject({
      method: 'DELETE', url: '/orgs/' + org.id,
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /orgs/:id/members/invite', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('creates an invitation (201) with token', async () => {
    const org = getOrgStore().create({ name: 'Inv' }, 'admin');
    const res = await server.inject({
      method: 'POST', url: '/orgs/' + org.id + '/members/invite',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { email: 'new@example.com', role: 'analyst' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.token).toBeTruthy();
    expect(body.role).toBe('analyst');
    expect(body.expiresAt).toBeTruthy();
  });

  it('returns 403 for non-admin', async () => {
    const org = getOrgStore().create({ name: 'Inv' }, 'other');
    const res = await server.inject({
      method: 'POST', url: '/orgs/' + org.id + '/members/invite',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { email: 'x@x.com' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /orgs/invites/:token/accept', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('accepts a valid invitation', async () => {
    // Create org under a different keyId so 'admin' (env key) can accept without being a duplicate
    const org = getOrgStore().create({ name: 'Accept' }, 'other-owner');
    const invite = getOrgStore().createInvite(org.id, 'new@x.com', 'viewer', 'other-owner');
    const res = await server.inject({
      method: 'POST', url: '/orgs/invites/' + invite.token + '/accept',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.member.role).toBe('viewer');
  });

  it('returns 400 for invalid token', async () => {
    const res = await server.inject({
      method: 'POST', url: '/orgs/invites/badtoken/accept',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /orgs/:id/members/:memberId/role', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('updates member role', async () => {
    const org = getOrgStore().create({ name: 'Role' }, 'admin');
    getOrgStore().addMember(org.id, 'analyst1', 'analyst');
    const res = await server.inject({
      method: 'PATCH', url: '/orgs/' + org.id + '/members/analyst1/role',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).role).toBe('viewer');
  });

  it('returns 400 when demoting last admin', async () => {
    const org = getOrgStore().create({ name: 'LA' }, 'admin');
    const res = await server.inject({
      method: 'PATCH', url: '/orgs/' + org.id + '/members/admin/role',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /orgs/:id/members/:memberId', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('removes a member (204)', async () => {
    const org = getOrgStore().create({ name: 'Rem' }, 'admin');
    getOrgStore().addMember(org.id, 'viewer1', 'viewer');
    const res = await server.inject({
      method: 'DELETE', url: '/orgs/' + org.id + '/members/viewer1',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(204);
    expect(getOrgStore().getMemberRole(org.id, 'viewer1')).toBeNull();
  });
});

describe('POST /orgs/:id/keys', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('creates a scoped API key (201)', async () => {
    const org = getOrgStore().create({ name: 'Keys' }, 'admin');
    const res = await server.inject({
      method: 'POST', url: '/orgs/' + org.id + '/keys',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { name: 'CI Key', permissions: ['scan'] },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.key).toBeTruthy();   // raw key shown once
    expect(body.keyId).toBeTruthy();
    expect(body.permissions).toContain('scan');
  });

  it('key is named with org slug prefix', async () => {
    const org = getOrgStore().create({ name: 'My Org' }, 'admin');
    const res = await server.inject({
      method: 'POST', url: '/orgs/' + org.id + '/keys',
      headers: { 'x-api-key': 'admin-key', 'content-type': 'application/json' },
      payload: { name: 'Deploy Key' },
    });
    const body = JSON.parse(res.body);
    expect(body.name).toContain('my-org');
  });
});

describe('GET /orgs/:id/keys', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('lists org keys', async () => {
    const org = getOrgStore().create({ name: 'ListKeys' }, 'admin');
    getOrgStore().createOrgKey(org.id, 'K1', ['scan'], 'admin');
    const res = await server.inject({
      method: 'GET', url: '/orgs/' + org.id + '/keys',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.keys.length).toBeGreaterThan(0);
    expect(body.keys[0].keyName).toBe('K1');
  });
});

describe('DELETE /orgs/:id/keys/:keyId', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('revokes org key (204)', async () => {
    const org = getOrgStore().create({ name: 'Revoke' }, 'admin');
    const { apiKey } = getOrgStore().createOrgKey(org.id, 'TmpKey', ['scan'], 'admin');
    const res = await server.inject({
      method: 'DELETE', url: '/orgs/' + org.id + '/keys/' + apiKey.id,
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(204);
    expect(getOrgStore().get(org.id)!.keys).toHaveLength(0);
  });
});

describe('GET /orgs/:id/usage', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns usage summary for the org', async () => {
    const org = getOrgStore().create({ name: 'Usage' }, 'admin');
    const res = await server.inject({
      method: 'GET', url: '/orgs/' + org.id + '/usage',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.orgId).toBe(org.id);
    expect(body.totalScans).toBe(0);
    expect(typeof body.period).toBe('string');
  });

  it('accepts month query param', async () => {
    const org = getOrgStore().create({ name: 'UsageM' }, 'admin');
    const res = await server.inject({
      method: 'GET', url: '/orgs/' + org.id + '/usage?month=2025-01',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).period).toBe('2025-01');
  });
});

describe('GET /orgs/:id/invites', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('lists pending invitations', async () => {
    const org = getOrgStore().create({ name: 'InvList' }, 'admin');
    getOrgStore().createInvite(org.id, 'a@x.com', 'analyst', 'admin');
    getOrgStore().createInvite(org.id, 'b@x.com', 'viewer', 'admin');
    const res = await server.inject({
      method: 'GET', url: '/orgs/' + org.id + '/invites',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.invites).toHaveLength(2);
    expect(body.total).toBe(2);
  });
});
