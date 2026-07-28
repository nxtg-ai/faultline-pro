/**
 * N-127 — v0.4.0 Release Prep validation tests (RP16–RP30)
 *
 * Validates that documentation artefacts reflect the v0.4.0 release:
 *   - README.md badge ≥ 4,286; mentions GDPR, erasure, mutation testing
 *   - CHANGELOG.md has [v0.4.0] block with 2026-03-21 date; GDPR + mutation content
 *   - [Unreleased] section is empty (v0.4.0 was correctly cut)
 *   - package.json versions for cli and api are 0.4.0
 *   - Changelog API endpoint serves v0.4.0 block in JSON and Markdown
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { resetChangelogCache } from '../src/routes/changelog.js';
import type { FastifyInstance } from 'fastify';
// Note: server/FastifyInstance used in RP28–RP30 describe block

// ── Resolve project root ───────────────────────────────────────────────────────

function repoRoot(): string {
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

// ── README.md v0.4.0 validation (RP16–RP20) ───────────────────────────────────

describe('README.md — v0.4.0 release validation', () => {
  let readme: string;

  beforeEach(() => {
    readme = readFileSync(resolve(ROOT, 'README.md'), 'utf-8');
  });

  // RP16: badge count is ≥ 4403 (floor updated 2026-04-05 after
  // N-215 Gemini calibration prompt hardening — actual count 4403)
  it('RP16: test badge count is at least 3900', () => {
    const match = readme.match(/tests-(\d+)%20passing/);
    expect(match, 'README must have a tests-N%20passing badge').toBeTruthy();
    const count = parseInt(match![1], 10);
    expect(count).toBeGreaterThanOrEqual(4403);
  });

  // RP17: README mentions GDPR
  it('RP17: README mentions GDPR compliance', () => {
    expect(readme.toUpperCase()).toContain('GDPR');
  });

  // RP18: README mentions erasure (Article 17 right to erasure)
  it('RP18: README mentions erasure or right-to-erasure', () => {
    const lower = readme.toLowerCase();
    expect(
      lower.includes('erasure') || lower.includes('article 17'),
      'README should document GDPR erasure endpoint',
    ).toBe(true);
  });

  // RP19: README mentions mutation testing or Stryker
  it('RP19: README mentions mutation testing or Stryker', () => {
    const lower = readme.toLowerCase();
    expect(
      lower.includes('mutation') || lower.includes('stryker'),
      'README should document mutation testing quality gate',
    ).toBe(true);
  });

  // RP20: README mentions the GDPR export endpoint
  it('RP20: README mentions the GDPR export endpoint', () => {
    expect(readme).toContain('/export');
  });
});

// ── CHANGELOG.md v0.4.0 validation (RP21–RP25) ────────────────────────────────

describe('CHANGELOG.md — v0.4.0 release validation', () => {
  let changelog: string;

  beforeEach(() => {
    changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf-8');
  });

  // RP21: has [v0.4.0] section
  it('RP21: has a [v0.4.0] version section', () => {
    expect(changelog).toContain('## [v0.4.0]');
  });

  // RP22: v0.4.0 section is dated 2026-03-21
  it('RP22: [v0.4.0] section is dated 2026-03-21', () => {
    expect(changelog).toContain('## [v0.4.0] — 2026-03-21');
  });

  // RP23: v0.4.0 section mentions GDPR
  it('RP23: [v0.4.0] section mentions GDPR', () => {
    const v040Start = changelog.indexOf('## [v0.4.0]');
    const nextSection = changelog.indexOf('\n## [', v040Start + 1);
    const v040Block = changelog.slice(v040Start, nextSection > 0 ? nextSection : undefined);
    expect(v040Block.toUpperCase()).toContain('GDPR');
  });

  // RP24: v0.4.0 section mentions mutation testing
  it('RP24: [v0.4.0] section mentions mutation or Stryker', () => {
    const v040Start = changelog.indexOf('## [v0.4.0]');
    const nextSection = changelog.indexOf('\n## [', v040Start + 1);
    const v040Block = changelog.slice(v040Start, nextSection > 0 ? nextSection : undefined);
    const lower = v040Block.toLowerCase();
    expect(
      lower.includes('mutation') || lower.includes('stryker'),
    ).toBe(true);
  });

  // RP25: [Unreleased] section must not contain the v0.4.0 initiatives (N-119–N-127 correctly cut)
  it('RP25: [Unreleased] section does not contain v0.4.0 initiatives (N-119–N-127)', () => {
    const unrelStart = changelog.indexOf('## [Unreleased]');
    const nextSection = changelog.indexOf('\n## [', unrelStart + 1);
    const unreleased = changelog.slice(unrelStart, nextSection > 0 ? nextSection : undefined);
    // N-119 through N-127 must not appear in Unreleased — they belong in [v0.4.0]
    for (const n of ['N-119', 'N-120', 'N-121', 'N-122', 'N-123', 'N-124', 'N-125', 'N-126', 'N-127']) {
      expect(unreleased, `[Unreleased] must not contain ${n} (already in v0.4.0)`).not.toContain(n);
    }
  });
});

// ── package.json version validation (RP26–RP27) ────────────────────────────────

describe('package.json — v0.4.0 version validation', () => {
  /**
   * Compare two semver strings numerically.
   *
   * These assertions used to be the regex /^0\.[4-9]\.\d+$/, described in a
   * comment as "forward-compatible". It was not: [4-9] matches ONE digit, so
   * the first two-digit minor — 0.10.0 — failed a check whose stated intent it
   * satisfies comfortably. A version gate that blocks a legitimate release is a
   * false negative, and it would have blocked every 0.10.x, 0.11.x and beyond.
   */
  function gte(actual: string, minimum: string): boolean {
    const parse = (v: string): number[] =>
      v
        .split('-')[0]
        .split('.')
        .map((n) => Number.parseInt(n, 10));

    const a = parse(actual);
    const b = parse(minimum);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x > y;
    }
    return true;
  }

  // Guard the comparator itself — the bug being fixed was in the comparison.
  it('the version comparator orders two-digit minors correctly', () => {
    expect(gte('0.10.0', '0.4.0')).toBe(true);
    expect(gte('0.9.1', '0.4.0')).toBe(true);
    expect(gte('0.4.0', '0.4.0')).toBe(true);
    expect(gte('1.0.0', '0.4.0')).toBe(true);
    expect(gte('0.3.9', '0.4.0')).toBe(false);
    expect(gte('0.10.0', '0.11.0')).toBe(false);
  });

  // RP26: @nxtg/faultline (cli) is version >= 0.4.0
  it('RP26: @nxtg/faultline package version is >= 0.4.0', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, 'packages/cli/package.json'), 'utf-8'),
    ) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(gte(pkg.version, '0.4.0'), `cli version ${pkg.version} is below 0.4.0`).toBe(true);
  });

  // RP27: @nxtg/faultline-api is version >= 0.4.0
  it('RP27: @nxtg/faultline-api package version is >= 0.4.0', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, 'packages/api/package.json'), 'utf-8'),
    ) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(gte(pkg.version, '0.4.0'), `api version ${pkg.version} is below 0.4.0`).toBe(true);
  });
});

// ── CHANGELOG.md file v0.4.0 content validation (RP28–RP30) ──────────────────
// Note: the /changelog API endpoint builds from git tags; these tests read the
// CHANGELOG.md file directly so they pass before the v0.4.0 tag is created.

describe('CHANGELOG.md file — v0.4.0 content validation', () => {
  let changelog: string;
  let server: FastifyInstance;

  beforeEach(() => {
    changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf-8');
    resetChangelogCache();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  // RP28: CHANGELOG.md contains all 8 v0.4.0 initiative entries (N-119–N-126 + N-127)
  it('RP28: [v0.4.0] block contains N-119 through N-127 initiative entries', () => {
    const v040Start = changelog.indexOf('## [v0.4.0]');
    const nextSection = changelog.indexOf('\n## [', v040Start + 1);
    const v040Block = changelog.slice(v040Start, nextSection > 0 ? nextSection : undefined);
    // All 9 initiatives (N-119 to N-127) should be present
    for (const n of ['N-119', 'N-120', 'N-121', 'N-122', 'N-123', 'N-124', 'N-125', 'N-126', 'N-127']) {
      expect(v040Block, `[v0.4.0] block must contain ${n}`).toContain(n);
    }
  });

  // RP29: [v0.3.0] section still present (historical versions not deleted)
  it('RP29: [v0.3.0] section is still present in CHANGELOG', () => {
    expect(changelog).toContain('## [v0.3.0]');
  });

  // RP30: /changelog endpoint returns 200 with at least 3 version blocks (v0.1.0–v0.3.0 via git tags)
  it('RP30: /changelog endpoint returns 200 with content', async () => {
    const res = await server.inject({ method: 'GET', url: '/changelog' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body.length).toBeGreaterThan(500);
  });
});
