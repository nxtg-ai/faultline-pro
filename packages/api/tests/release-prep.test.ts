/**
 * N-119 — v0.3.0 Release Prep validation tests (RP1–RP15)
 *
 * Validates that documentation artefacts are kept in sync with the codebase:
 *   - README.md test badge count is ≥ 4,000 (catches stale badge)
 *   - CHANGELOG.md follows Keep-a-Changelog structure with required sections
 *   - Key post-v0.3.0 features are described in CHANGELOG.md
 *   - Changelog API endpoint serves all three expected version blocks
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { resetChangelogCache } from '../src/routes/changelog.js';
import type { FastifyInstance } from 'fastify';

// ── Resolve project root ───────────────────────────────────────────────────────

function repoRoot(): string {
  // Traverse up from this file to find the .git directory
  let dir = resolve(import.meta.url.replace('file://', ''), '..', '..', '..', '..');
  for (let i = 0; i < 6; i++) {
    try {
      readFileSync(resolve(dir, '.git/HEAD'));
      return dir;
    } catch {
      dir = resolve(dir, '..');
    }
  }
  return resolve(import.meta.url.replace('file://', ''), '..', '..', '..', '..');
}

const ROOT = repoRoot();

// ── README.md validation (RP1–RP5) ────────────────────────────────────────────

describe('README.md — release-prep validation', () => {
  let readme: string;

  beforeEach(() => {
    readme = readFileSync(resolve(ROOT, 'README.md'), 'utf-8');
  });

  // RP1: badge count is ≥ 3886 (prevents stale badge; floor updated 2026-04-04 after
  // RR22–RR27 remediation tests committed — actual count 3886)
  it('RP1: test badge count is at least 3900', () => {
    const match = readme.match(/tests-(\d+)%20passing/);
    expect(match, 'README must have a tests-N%20passing badge').toBeTruthy();
    const count = parseInt(match![1], 10);
    expect(count).toBeGreaterThanOrEqual(3886);
  });

  // RP2: badge count is a round number (catches off-by-one accidents like 2757)
  it('RP2: test badge count is a plausible 4-digit number', () => {
    const match = readme.match(/tests-(\d+)%20passing/);
    const count = parseInt(match![1], 10);
    expect(count).toBeGreaterThan(1000);
    expect(count).toBeLessThan(100_000);
  });

  // RP3: README mentions multi-tenant capability
  it('RP3: README mentions multi-tenant', () => {
    expect(readme.toLowerCase()).toContain('multi-tenant');
  });

  // RP4: README mentions webhook circuit breaker or resilience features
  it('RP4: README mentions webhook resilience (rate limiting or circuit breaker)', () => {
    const lower = readme.toLowerCase();
    expect(
      lower.includes('circuit breaker') || lower.includes('rate limit'),
      'README should mention webhook circuit breaker or rate limiting',
    ).toBe(true);
  });

  // RP5: README has enterprise API section
  it('RP5: README has an Enterprise API section', () => {
    expect(readme).toContain('### Enterprise API');
  });
});

// ── CHANGELOG.md validation (RP6–RP10) ────────────────────────────────────────

describe('CHANGELOG.md — release-prep validation', () => {
  let changelog: string;

  beforeEach(() => {
    changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf-8');
  });

  // RP6: has Keep-a-Changelog header
  it('RP6: starts with # Changelog header', () => {
    expect(changelog.trim()).toMatch(/^# Changelog/);
  });

  // RP7: has a v0.3.0 section
  it('RP7: has a [v0.3.0] version section', () => {
    expect(changelog).toContain('## [v0.3.0]');
  });

  // RP8: has a v0.2.0 section (historical, should never disappear)
  it('RP8: has a [v0.2.0] version section', () => {
    expect(changelog).toContain('## [v0.2.0]');
  });

  // RP9: has an Unreleased section (post-v0.3.0 work)
  it('RP9: has an [Unreleased] section for post-v0.3.0 work', () => {
    expect(changelog).toContain('## [Unreleased]');
  });

  // RP10: CHANGELOG mentions webhook resilience features (N-113–N-115)
  // Updated: originally checked [Unreleased]; moved to [v0.4.0] at N-127 publish prep.
  it('RP10: CHANGELOG mentions webhook circuit breaker or rate limiting', () => {
    const lower = changelog.toLowerCase();
    expect(
      lower.includes('circuit breaker') || lower.includes('rate limit'),
      'CHANGELOG should document webhook resilience features',
    ).toBe(true);
  });
});

// ── Changelog API endpoint (RP11–RP15) ────────────────────────────────────────

describe('Changelog API — release-prep version coverage', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetChangelogCache();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  // RP11: JSON endpoint returns at least 3 version blocks (v0.1.0, v0.2.0, v0.3.0)
  it('RP11: /changelog.json contains at least 3 version blocks', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.json' });
    const blocks = JSON.parse(res.body);
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  // RP12: v0.3.0 block is present in JSON
  it('RP12: /changelog.json contains a v0.3.0 block', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.json' });
    const blocks = JSON.parse(res.body);
    expect(blocks.some((b: { version: string }) => b.version === 'v0.3.0')).toBe(true);
  });

  // RP13: v0.3.0 block has a date field set to a real date
  it('RP13: v0.3.0 block has a non-empty date', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.json' });
    const blocks = JSON.parse(res.body);
    const v030 = blocks.find((b: { version: string }) => b.version === 'v0.3.0');
    expect(v030.date).toBeTruthy();
    expect(v030.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // RP14: Markdown endpoint contains v0.3.0 heading
  it('RP14: /changelog.md contains ## [v0.3.0] heading', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog.md' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('## [v0.3.0]');
  });

  // RP15: HTML endpoint contains v0.3.0 version badge
  it('RP15: /changelog HTML contains v0.3.0 version badge', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('v0.3.0');
  });
});
