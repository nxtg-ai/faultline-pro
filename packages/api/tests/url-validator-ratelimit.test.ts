/**
 * URL Validator + RateLimit Plugin Tests (N-148) — UV1–UV13, RT1–RT5
 *
 * Validates: N-34 (Claim Evidence Linking), N-39 (Production API Hardening)
 *
 * Covers uncovered branches in two modules:
 *   UV1–UV13 : url-validator.ts — default _fetcher body (lines 20-30),
 *              resetUrlFetcher body (lines 40-50), 3xx redirect scoreSource
 *              branch (line 67), title-keyword relevance, last-modified
 *              recency, buildEvidenceLinks edge cases
 *   RT1–RT5  : plugins/ratelimit.ts resolveTier() — admin env-key path,
 *              keystore admin-permission, keystore pro-permission, free
 *              default, unknown keyId fallback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateSourceUrl,
  buildEvidenceLinks,
  setUrlFetcher,
  resetUrlFetcher,
} from '../src/lib/url-validator.js';
import { resolveTier } from '../src/plugins/ratelimit.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';

// ===========================================================================
// UV1–UV13 — url-validator.ts
// ===========================================================================

describe('url-validator — default _fetcher (lines 20-30)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    // Reset to the default fetcher (the one under test) so stubs are used
    resetUrlFetcher();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Restore to default so other tests are unaffected
    resetUrlFetcher();
  });

  it('UV1: 200 response → available=true, evidenceScore >= 50', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { forEach: vi.fn() },
    } as unknown as Response);

    const result = await validateSourceUrl('https://example.com/study', 'Study', 'test claim');
    expect(result.available).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.evidenceScore).toBeGreaterThanOrEqual(50);
  });

  it('UV2: 404 response → available=false, evidenceScore < 50', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      headers: { forEach: vi.fn() },
    } as unknown as Response);

    const result = await validateSourceUrl('https://example.com/missing', 'Missing', 'test');
    expect(result.available).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.evidenceScore).toBeLessThan(50);
  });

  it('UV3: fetch throws network error → status=0, available=false (catch branch lines 29-30)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await validateSourceUrl('https://unreachable.local', 'Unreachable', 'test');
    expect(result.available).toBe(false);
    expect(result.statusCode).toBe(0);
    expect(result.evidenceScore).toBe(0);
  });

  it('UV4: resetUrlFetcher() reinstalls default fetcher — covers lines 40-50', async () => {
    // Set a custom fetcher then reset to default
    setUrlFetcher(async () => ({ status: 999, headers: {} }));
    resetUrlFetcher(); // installs the default (with real fetch)

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { forEach: vi.fn() },
    } as unknown as Response);

    const result = await validateSourceUrl('https://example.com', 'Example', 'test');
    expect(result.statusCode).toBe(200); // default fetcher used, not the 999 stub
  });
});

describe('url-validator — scoreSource() branches', () => {
  afterEach(() => resetUrlFetcher());

  it('UV5: 3xx redirect → available=true, evidenceScore 30–79 (line 67 branch)', async () => {
    setUrlFetcher(async () => ({ status: 301, headers: {} }));
    const result = await validateSourceUrl('https://example.com/moved', 'Moved Page', 'test claim');
    // 301 means available (>= 200 && < 400)
    expect(result.available).toBe(true);
    expect(result.evidenceScore).toBeGreaterThanOrEqual(30);
    expect(result.evidenceScore).toBeLessThan(50); // got redirect bonus (30) not available bonus (50)
  });

  it('UV6: matching title keywords increase score above 50', async () => {
    setUrlFetcher(async () => ({ status: 200, headers: {} }));
    // Claim contains "medical" "diagnosis" (>4 chars), title also contains them
    const result = await validateSourceUrl(
      'https://example.com/medical',
      'medical diagnosis study',
      'medical diagnosis accuracy research',
    );
    expect(result.evidenceScore).toBeGreaterThan(50); // 50 (available) + keyword bonus
  });

  it('UV7: last-modified within 2 years adds +20 to score', async () => {
    const recentDate = new Date();
    recentDate.setMonth(recentDate.getMonth() - 6); // 6 months ago
    setUrlFetcher(async () => ({
      status: 200,
      headers: { 'last-modified': recentDate.toISOString() },
    }));

    const result = await validateSourceUrl('https://example.com', 'Fresh article', 'test');
    // 50 (available) + 0 (no keyword match with 'test' — 4 chars, filtered) + 20 (recency) = 70
    expect(result.evidenceScore).toBe(70);
    expect(result.lastModified).toBe(recentDate.toISOString());
  });

  it('UV8: last-modified older than 2 years → no recency bonus', async () => {
    const oldDate = new Date();
    oldDate.setFullYear(oldDate.getFullYear() - 3); // 3 years ago
    setUrlFetcher(async () => ({
      status: 200,
      headers: { 'last-modified': oldDate.toISOString() },
    }));

    const result = await validateSourceUrl('https://example.com', 'Old article', 'test');
    // 50 (available) + 0 (keyword) + 0 (old date) = 50
    expect(result.evidenceScore).toBe(50);
  });

  it('UV9: status 0 (unreachable) → evidenceScore=0, available=false', async () => {
    setUrlFetcher(async () => ({ status: 0, headers: {} }));
    const result = await validateSourceUrl('https://unreachable.local', 'Unreachable', 'test');
    expect(result.available).toBe(false);
    expect(result.statusCode).toBe(0);
    expect(result.evidenceScore).toBe(0);
  });
});

describe('buildEvidenceLinks — edge cases', () => {
  afterEach(() => resetUrlFetcher());

  it('UV10: no claims → returns empty array', async () => {
    setUrlFetcher(async () => ({ status: 200, headers: {} }));
    const result = await buildEvidenceLinks([], {});
    expect(result).toEqual([]);
  });

  it('UV11: claim with no verification entry → sources=[], overallEvidenceScore=0', async () => {
    setUrlFetcher(async () => ({ status: 200, headers: {} }));
    const result = await buildEvidenceLinks(
      [{ id: 'c1', text: 'A claim with no sources.' }],
      {}, // no entry for c1
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.claimId).toBe('c1');
    expect(result[0]!.sources).toEqual([]);
    expect(result[0]!.overallEvidenceScore).toBe(0);
  });

  it('UV12: claim with empty sources array → overallEvidenceScore=0', async () => {
    setUrlFetcher(async () => ({ status: 200, headers: {} }));
    const result = await buildEvidenceLinks(
      [{ id: 'c1', text: 'Claim text.' }],
      { c1: { sources: [] } },
    );
    expect(result[0]!.overallEvidenceScore).toBe(0);
    expect(result[0]!.sources).toHaveLength(0);
  });

  it('UV13: multiple claims each get their own EvidenceLink with correct claimId', async () => {
    setUrlFetcher(async () => ({ status: 200, headers: {} }));
    const result = await buildEvidenceLinks(
      [
        { id: 'c1', text: 'First claim.' },
        { id: 'c2', text: 'Second claim.' },
      ],
      {
        c1: { sources: [{ uri: 'https://a.com', title: 'A' }] },
        c2: { sources: [{ uri: 'https://b.com', title: 'B' }] },
      },
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.claimId).toBe('c1');
    expect(result[0]!.sources).toHaveLength(1);
    expect(result[1]!.claimId).toBe('c2');
    expect(result[1]!.sources).toHaveLength(1);
    // Both got 200 → evidenceScore >= 50
    expect(result[0]!.overallEvidenceScore).toBeGreaterThanOrEqual(50);
    expect(result[1]!.overallEvidenceScore).toBeGreaterThanOrEqual(50);
  });
});

// ===========================================================================
// RT1–RT5 — plugins/ratelimit.ts resolveTier()
// ===========================================================================

describe('resolveTier() — all branches', () => {
  beforeEach(() => resetKeyStore());
  afterEach(() => resetKeyStore());

  it('RT1: keyId="admin" → "admin" without touching keystore (first branch)', () => {
    expect(resolveTier('admin')).toBe('admin');
  });

  it('RT2: keystore key with "admin" permission → "admin"', () => {
    const key = getKeyStore().create('admin-user', ['scan', 'admin']);
    expect(resolveTier(key.id)).toBe('admin');
  });

  it('RT3: keystore key with "pro" permission → "pro"', () => {
    const key = getKeyStore().create('pro-user', ['scan', 'pro']);
    expect(resolveTier(key.id)).toBe('pro');
  });

  it('RT4: keystore key with "scan" only → "free" (default branch)', () => {
    const key = getKeyStore().create('free-user', ['scan']);
    expect(resolveTier(key.id)).toBe('free');
  });

  it('RT5: unknown keyId (validateById returns null) → "free"', () => {
    expect(resolveTier('00000000-0000-0000-0000-000000000000')).toBe('free');
  });
});
