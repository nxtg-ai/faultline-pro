import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseConventionalCommit, toMarkdown } from '../src/lib/changelog.js';
import type { VersionBlock } from '../src/lib/changelog.js';
import { buildServer } from '../src/server.js';
import { resetChangelogCache } from '../src/routes/changelog.js';
import type { FastifyInstance } from 'fastify';

// ── parseConventionalCommit ───────────────────────────────────────────────────

describe('parseConventionalCommit', () => {
  it('parses a feat commit', () => {
    const e = parseConventionalCommit('abc1234', 'feat: add export endpoint');
    expect(e.type).toBe('feat');
    expect(e.summary).toBe('add export endpoint');
    expect(e.breaking).toBe(false);
    expect(e.scope).toBeUndefined();
  });

  it('parses a fix commit', () => {
    const e = parseConventionalCommit('abc1234', 'fix: guard null dereference in scan');
    expect(e.type).toBe('fix');
    expect(e.summary).toBe('guard null dereference in scan');
  });

  it('parses a scoped commit', () => {
    const e = parseConventionalCommit('abc1234', 'feat(auth): add API key rotation');
    expect(e.type).toBe('feat');
    expect(e.scope).toBe('auth');
    expect(e.summary).toBe('add API key rotation');
  });

  it('detects breaking change via ! suffix', () => {
    const e = parseConventionalCommit('abc1234', 'feat!: remove legacy /v1 prefix');
    expect(e.breaking).toBe(true);
  });

  it('detects breaking change in scoped commit', () => {
    const e = parseConventionalCommit('abc1234', 'feat(api)!: rename claimId → claim_id');
    expect(e.breaking).toBe(true);
    expect(e.scope).toBe('api');
  });

  it('falls back to type=other for non-conventional subjects', () => {
    const e = parseConventionalCommit('abc1234', 'random commit message without prefix');
    expect(e.type).toBe('other');
    expect(e.summary).toBe('random commit message without prefix');
  });

  it('preserves hash field', () => {
    const e = parseConventionalCommit('deadbeef', 'docs: update README');
    expect(e.hash).toBe('deadbeef');
  });

  it('parses docs type', () => {
    const e = parseConventionalCommit('abc1234', 'docs: add OpenAPI spec');
    expect(e.type).toBe('docs');
  });

  it('is case-insensitive on type', () => {
    const e = parseConventionalCommit('abc1234', 'FEAT: something');
    expect(e.type).toBe('feat');
  });
});

// ── toMarkdown ────────────────────────────────────────────────────────────────

describe('toMarkdown', () => {
  const blocks: VersionBlock[] = [
    {
      version:  'v1.2.0',
      tag:      'v1.2.0',
      date:     '2026-03-20',
      features: [{ hash: 'abc', subject: 'feat: new thing', type: 'feat', scope: undefined, summary: 'new thing', breaking: false }],
      fixes:    [{ hash: 'def', subject: 'fix: null crash', type: 'fix', scope: undefined, summary: 'null crash', breaking: false }],
      breaking: [],
      other:    [],
    },
  ];

  it('starts with # Changelog header', () => {
    expect(toMarkdown(blocks)).toMatch(/^# Changelog/);
  });

  it('includes version heading', () => {
    expect(toMarkdown(blocks)).toContain('## [v1.2.0]');
  });

  it('includes date', () => {
    expect(toMarkdown(blocks)).toContain('2026-03-20');
  });

  it('includes ### Added section for features', () => {
    expect(toMarkdown(blocks)).toContain('### Added');
    expect(toMarkdown(blocks)).toContain('- new thing');
  });

  it('includes ### Fixed section for fixes', () => {
    expect(toMarkdown(blocks)).toContain('### Fixed');
    expect(toMarkdown(blocks)).toContain('- null crash');
  });

  it('includes Breaking Changes section when present', () => {
    const withBreaking: VersionBlock[] = [{
      ...blocks[0]!,
      breaking: [{ hash: 'ghi', subject: 'feat!: drop v1', type: 'feat', scope: undefined, summary: 'drop v1', breaking: true }],
    }];
    const md = toMarkdown(withBreaking);
    expect(md).toContain('Breaking Changes');
    expect(md).toContain('- drop v1');
  });

  it('shows no-changes note for empty version', () => {
    const empty: VersionBlock[] = [{ version: 'v0.0.1', tag: 'v0.0.1', date: '2026-01-01', features: [], fixes: [], breaking: [], other: [] }];
    expect(toMarkdown(empty)).toContain('No recorded changes');
  });
});

// ── HTTP endpoints ────────────────────────────────────────────────────────────

describe('GET /changelog', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetChangelogCache();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 200 with text/html', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML contains Faultline Pro heading', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog' });
    expect(res.body).toContain('Faultline Pro');
  });

  it('HTML contains at least one version entry', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog' });
    // Repo has tags so there should be version blocks
    expect(res.body).toContain('version-badge');
  });

  it('HTML contains link to /changelog.json', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog' });
    expect(res.body).toContain('/changelog.json');
  });

  it('HTML contains link to /changelog.md', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog' });
    expect(res.body).toContain('/changelog.md');
  });
});

describe('GET /changelog.json', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetChangelogCache();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 200 with application/json', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('response is an array', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.json' });
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });

  it('each block has version, date, features, fixes, breaking, other', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.json' });
    const blocks: VersionBlock[] = JSON.parse(res.body);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b).toHaveProperty('version');
      expect(b).toHaveProperty('date');
      expect(b).toHaveProperty('features');
      expect(b).toHaveProperty('fixes');
      expect(b).toHaveProperty('breaking');
      expect(b).toHaveProperty('other');
    }
  });

  it('contains a v0.2.0 block', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.json' });
    const blocks: VersionBlock[] = JSON.parse(res.body);
    expect(blocks.some(b => b.version === 'v0.2.0')).toBe(true);
  });
});

describe('GET /changelog.md', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetChangelogCache();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 200 with text/markdown content-type', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.md' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
  });

  it('body starts with # Changelog', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.md' });
    expect(res.body).toMatch(/^# Changelog/);
  });

  it('contains version headings', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.md' });
    expect(res.body).toContain('## [v0.2.0]');
  });
});
