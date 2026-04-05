import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetPluginRegistry, validatePublishInput, getPluginRegistry } from '../src/store/plugin-registry.js';
import type { FastifyInstance } from 'fastify';

// ── Helpers ───────────────────────────────────────────────────────────────────

const KEY = 'test-key';

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    name:        'faultline-plugin-no-todos',
    version:     '1.0.0',
    description: 'Flags unresolved TODO markers in AI-generated content',
    type:        'rule',
    keywords:    ['todos', 'lint'],
    ...overrides,
  };
}

// ── validatePublishInput (pure) ───────────────────────────────────────────────

describe('validatePublishInput', () => {
  it('returns no errors for a valid payload', () => {
    expect(validatePublishInput(validPayload() as Parameters<typeof validatePublishInput>[0])).toHaveLength(0);
  });

  it('rejects missing name', () => {
    const { name: _, ...rest } = validPayload();
    const errs = validatePublishInput({ ...rest, name: '' } as Parameters<typeof validatePublishInput>[0]);
    expect(errs.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects uppercase in name', () => {
    const errs = validatePublishInput(validPayload({ name: 'MyPlugin' }) as Parameters<typeof validatePublishInput>[0]);
    expect(errs.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects invalid semver', () => {
    const errs = validatePublishInput(validPayload({ version: 'v1' }) as Parameters<typeof validatePublishInput>[0]);
    expect(errs.some(e => e.field === 'version')).toBe(true);
  });

  it('rejects description shorter than 10 chars', () => {
    const errs = validatePublishInput(validPayload({ description: 'short' }) as Parameters<typeof validatePublishInput>[0]);
    expect(errs.some(e => e.field === 'description')).toBe(true);
  });

  it('rejects invalid type', () => {
    const errs = validatePublishInput(validPayload({ type: 'unknown' }) as Parameters<typeof validatePublishInput>[0]);
    expect(errs.some(e => e.field === 'type')).toBe(true);
  });

  it('rejects more than 5 keywords', () => {
    const errs = validatePublishInput(validPayload({ keywords: ['a','b','c','d','e','f'] }) as Parameters<typeof validatePublishInput>[0]);
    expect(errs.some(e => e.field === 'keywords')).toBe(true);
  });

  it('rejects non-http repoUrl', () => {
    const errs = validatePublishInput(validPayload({ repoUrl: 'git@github.com:foo/bar.git' }) as Parameters<typeof validatePublishInput>[0]);
    expect(errs.some(e => e.field === 'repoUrl')).toBe(true);
  });

  it('accepts scoped package names', () => {
    expect(validatePublishInput(validPayload({ name: '@myorg/faultline-plugin' }) as Parameters<typeof validatePublishInput>[0])).toHaveLength(0);
  });
});

// ── POST /plugins/publish ─────────────────────────────────────────────────────

describe('POST /plugins/publish', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = KEY;
    resetPluginRegistry();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns 401 without API key', async () => {
    const res = await server.inject({
      method: 'POST', url: '/plugins/publish',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validPayload()),
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a new plugin and returns 201', async () => {
    const res = await server.inject({
      method: 'POST', url: '/plugins/publish',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: JSON.stringify(validPayload()),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.plugin.name).toBe('faultline-plugin-no-todos');
    expect(body.created).toBe(true);
  });

  it('updates existing plugin from same author and returns 200', async () => {
    await server.inject({
      method: 'POST', url: '/plugins/publish',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: JSON.stringify(validPayload()),
    });
    const res = await server.inject({
      method: 'POST', url: '/plugins/publish',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: JSON.stringify(validPayload({ version: '1.1.0' })),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.plugin.version).toBe('1.1.0');
    expect(body.created).toBe(false);
  });

  it('returns 400 for invalid payload', async () => {
    const res = await server.inject({
      method: 'POST', url: '/plugins/publish',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Bad Name', version: 'bad', description: 'x', type: 'rule' }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('returns 409 when same name published by different author', async () => {
    // Seed directly via store with a different author
    getPluginRegistry().publish(
      { name: 'faultline-plugin-no-todos', version: '1.0.0', description: 'A valid description over 10 chars', type: 'rule' },
      'other-author',
    );
    const res = await server.inject({
      method: 'POST', url: '/plugins/publish',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: JSON.stringify(validPayload()),
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('NAME_CONFLICT');
  });
});

// ── GET /plugins/search ───────────────────────────────────────────────────────

describe('GET /plugins/search', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = KEY;
    resetPluginRegistry();
    server = buildServer();
    // Seed the registry
    const r = getPluginRegistry();
    r.publish({ name: 'faultline-plugin-no-todos',   version: '1.0.0', description: 'Flags unresolved TODO markers',   type: 'rule',     keywords: ['todos', 'quality'] }, 'alice');
    r.publish({ name: 'faultline-plugin-echo',        version: '1.0.0', description: 'Echo provider for offline testing', type: 'provider', keywords: ['testing', 'mock'] },   'bob');
    r.publish({ name: 'faultline-plugin-statistics',  version: '2.0.0', description: 'Detect unverified statistics claims', type: 'rule', keywords: ['stats', 'quality'] }, 'carol');
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns all plugins when no filters', async () => {
    const res = await server.inject({ method: 'GET', url: '/plugins/search' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(3);
    expect(body.plugins).toHaveLength(3);
  });

  it('filters by q (name match)', async () => {
    const res = await server.inject({ method: 'GET', url: '/plugins/search?q=echo' });
    const body = JSON.parse(res.body);
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0].name).toContain('echo');
  });

  it('filters by q (keyword match)', async () => {
    const res = await server.inject({ method: 'GET', url: '/plugins/search?q=quality' });
    const body = JSON.parse(res.body);
    expect(body.plugins).toHaveLength(2);
  });

  it('filters by type=rule', async () => {
    const res = await server.inject({ method: 'GET', url: '/plugins/search?type=rule' });
    const body = JSON.parse(res.body);
    expect(body.plugins.every((p: { type: string }) => p.type === 'rule' || p.type === 'both')).toBe(true);
  });

  it('sorts by recent', async () => {
    const res = await server.inject({ method: 'GET', url: '/plugins/search?sort=recent' });
    const body = JSON.parse(res.body);
    const dates = body.plugins.map((p: { publishedAt: string }) => p.publishedAt);
    expect(dates[0] >= dates[1]).toBe(true);
  });

  it('sorts by name', async () => {
    const res = await server.inject({ method: 'GET', url: '/plugins/search?sort=name' });
    const body = JSON.parse(res.body);
    const names = body.plugins.map((p: { name: string }) => p.name);
    expect(names).toEqual([...names].sort());
  });

  it('paginates with limit and offset', async () => {
    const res = await server.inject({ method: 'GET', url: '/plugins/search?limit=2&offset=0' });
    const body = JSON.parse(res.body);
    expect(body.plugins).toHaveLength(2);
    expect(body.total).toBe(3);

    const res2 = await server.inject({ method: 'GET', url: '/plugins/search?limit=2&offset=2' });
    const body2 = JSON.parse(res2.body);
    expect(body2.plugins).toHaveLength(1);
  });

  it('returns empty plugins array when nothing matches', async () => {
    const res = await server.inject({ method: 'GET', url: '/plugins/search?q=nonexistent' });
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
    expect(body.plugins).toHaveLength(0);
  });

  it('is public — no auth required', async () => {
    const res = await server.inject({ method: 'GET', url: '/plugins/search' });
    expect(res.statusCode).toBe(200);
  });
});

// ── GET /plugins/:id ──────────────────────────────────────────────────────────

describe('GET /plugins/:id', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = KEY;
    resetPluginRegistry();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns the plugin for a valid id', async () => {
    const r = getPluginRegistry();
    const { listing } = r.publish(
      { name: 'faultline-plugin-test', version: '1.0.0', description: 'A test plugin for testing purposes', type: 'rule' },
      'tester',
    ) as { listing: import('../src/store/plugin-registry.js').PluginListing; created: boolean };

    const res = await server.inject({ method: 'GET', url: `/plugins/${listing.id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('faultline-plugin-test');
  });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({ method: 'GET', url: '/plugins/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });
});

// ── POST /plugins/install ─────────────────────────────────────────────────────

describe('POST /plugins/install', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = KEY;
    resetPluginRegistry();
    server = buildServer();
    getPluginRegistry().publish(
      { name: 'faultline-plugin-no-todos', version: '1.0.0', description: 'Flags unresolved TODO markers in content', type: 'rule' },
      'alice',
    );
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns 401 without API key', async () => {
    const res = await server.inject({
      method: 'POST', url: '/plugins/install',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'faultline-plugin-no-todos' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns plugin info and install instructions', async () => {
    const res = await server.inject({
      method: 'POST', url: '/plugins/install',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'faultline-plugin-no-todos' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.plugin.name).toBe('faultline-plugin-no-todos');
    expect(body.install.npm).toContain('npm install');
    expect(body.install.config).toContain('.faultlinerc.json');
  });

  it('increments download count on install', async () => {
    await server.inject({
      method: 'POST', url: '/plugins/install',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'faultline-plugin-no-todos' }),
    });
    await server.inject({
      method: 'POST', url: '/plugins/install',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'faultline-plugin-no-todos' }),
    });
    const search = await server.inject({ method: 'GET', url: '/plugins/search?q=no-todos' });
    const body = JSON.parse(search.body);
    expect(body.plugins[0].downloadCount).toBe(2);
  });

  it('returns 404 for unknown plugin name', async () => {
    const res = await server.inject({
      method: 'POST', url: '/plugins/install',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'faultline-plugin-nonexistent' }),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('NOT_FOUND');
  });

  it('install instructions include npm, yarn, pnpm variants', async () => {
    const res = await server.inject({
      method: 'POST', url: '/plugins/install',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'faultline-plugin-no-todos' }),
    });
    const { install } = JSON.parse(res.body);
    expect(install.npm).toMatch(/^npm install /);
    expect(install.yarn).toMatch(/^yarn add /);
    expect(install.pnpm).toMatch(/^pnpm add /);
  });
});
