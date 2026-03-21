/**
 * N-103 — `faultline keys rotation` CLI command
 *
 * KRC1–KRC10  getRotationStatus unit: threshold filter, OVERDUE/CRITICAL counts,
 *             sorting, never-rotated keys, disabled/expired passthrough,
 *             empty result, API error forwarding, day clamping.
 * KRC11–KRC15 formatRotationStatus formatter: empty state, OVERDUE chip,
 *             CRITICAL chip, never-rotated label, disabled/expired tags.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRotationStatus, formatRotationStatus } from '../cli/keys-client.js';

const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

// ── Mock apiFetch via global fetch ───────────────────────────────────────────

function makeUsageKey(overrides: {
  id?: string;
  name?: string;
  createdAt?: string;
  lastRotatedAt?: string | null;
  daysSinceLastRotation?: number | null;
  disabled?: boolean;
  isExpired?: boolean;
}) {
  return {
    id:                    overrides.id   ?? 'aabbccdd-0000-0000-0000-000000000000',
    name:                  overrides.name ?? 'Test Key',
    permissions:           ['scan'],
    createdAt:             overrides.createdAt ?? daysAgo(1),
    lastUsedAt:            null,
    lastRotatedAt:         overrides.lastRotatedAt ?? null,
    daysSinceCreation:     1,
    daysSinceLastUse:      null,
    daysSinceLastRotation: overrides.daysSinceLastRotation ?? null,
    isDormant:             false,
    isExpiringSoon:        false,
    isExpired:             overrides.isExpired ?? false,
    disabled:              overrides.disabled ?? false,
  };
}

function mockUsageResponse(keys: ReturnType<typeof makeUsageKey>[]) {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    text: async () => JSON.stringify({
      total: keys.length,
      dormantCount: 0,
      expiringSoonCount: 0,
      expiredCount: 0,
      disabledCount: 0,
      keys,
    }),
  } as unknown as Response);
}

function mockError(msg: string) {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: msg }),
  } as unknown as Response);
}

beforeEach(() => { vi.restoreAllMocks(); });

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('getRotationStatus — unit', () => {
  it('KRC1: key rotated 95 days ago — included with days=90', async () => {
    mockUsageResponse([makeUsageKey({ daysSinceLastRotation: 95, lastRotatedAt: daysAgo(95) })]);
    const result = await getRotationStatus('http://x', 'k', 90);
    expect(result.error).toBeUndefined();
    expect(result.keys).toHaveLength(1);
    expect(result.overdueCount).toBe(1);
  });

  it('KRC2: key rotated 60 days ago — excluded with days=90', async () => {
    mockUsageResponse([makeUsageKey({ daysSinceLastRotation: 60, lastRotatedAt: daysAgo(60) })]);
    const result = await getRotationStatus('http://x', 'k', 90);
    expect(result.keys).toHaveLength(0);
    expect(result.overdueCount).toBe(0);
  });

  it('KRC3: key 185 days old, never rotated — included and CRITICAL', async () => {
    mockUsageResponse([makeUsageKey({ createdAt: daysAgo(185), lastRotatedAt: null, daysSinceLastRotation: null })]);
    const result = await getRotationStatus('http://x', 'k', 90);
    expect(result.keys).toHaveLength(1);
    expect(result.criticalCount).toBe(1);
  });

  it('KRC4: keys sorted oldest-first by rotation age', async () => {
    mockUsageResponse([
      makeUsageKey({ id: 'aaaa-1', name: 'Newer', daysSinceLastRotation: 91, lastRotatedAt: daysAgo(91) }),
      makeUsageKey({ id: 'bbbb-2', name: 'Older', daysSinceLastRotation: 200, lastRotatedAt: daysAgo(200) }),
    ]);
    const result = await getRotationStatus('http://x', 'k', 90);
    expect(result.keys[0].name).toBe('Older');
    expect(result.keys[1].name).toBe('Newer');
  });

  it('KRC5: CRITICAL count includes only keys >=180d', async () => {
    mockUsageResponse([
      makeUsageKey({ id: 'a', name: 'A', daysSinceLastRotation: 95, lastRotatedAt: daysAgo(95) }),
      makeUsageKey({ id: 'b', name: 'B', daysSinceLastRotation: 185, lastRotatedAt: daysAgo(185) }),
    ]);
    const result = await getRotationStatus('http://x', 'k', 90);
    expect(result.keys).toHaveLength(2);
    expect(result.overdueCount).toBe(2);
    expect(result.criticalCount).toBe(1);
  });

  it('KRC6: disabled key still appears in results (rotation is independent of disabled state)', async () => {
    mockUsageResponse([makeUsageKey({ daysSinceLastRotation: 95, lastRotatedAt: daysAgo(95), disabled: true })]);
    const result = await getRotationStatus('http://x', 'k', 90);
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].disabled).toBe(true);
  });

  it('KRC7: expired key still appears in results', async () => {
    mockUsageResponse([makeUsageKey({ daysSinceLastRotation: 95, lastRotatedAt: daysAgo(95), isExpired: true })]);
    const result = await getRotationStatus('http://x', 'k', 90);
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].isExpired).toBe(true);
  });

  it('KRC8: API error forwarded as result.error', async () => {
    mockError('Forbidden');
    const result = await getRotationStatus('http://x', 'k', 90);
    expect(result.error).toBe('Forbidden');
    expect(result.keys).toHaveLength(0);
  });

  it('KRC9: empty store — overdueCount=0, criticalCount=0', async () => {
    mockUsageResponse([]);
    const result = await getRotationStatus('http://x', 'k', 90);
    expect(result.keys).toHaveLength(0);
    expect(result.overdueCount).toBe(0);
    expect(result.criticalCount).toBe(0);
  });

  it('KRC10: days parameter propagated correctly in result', async () => {
    mockUsageResponse([makeUsageKey({ daysSinceLastRotation: 40, lastRotatedAt: daysAgo(40) })]);
    const result = await getRotationStatus('http://x', 'k', 30);
    expect(result.days).toBe(30);
    expect(result.keys).toHaveLength(1); // 40 >= 30
  });
});

// ── Formatter tests ───────────────────────────────────────────────────────────

describe('formatRotationStatus — formatter', () => {
  it('KRC11: empty result — all-clear message', () => {
    const result = { days: 90, overdueCount: 0, criticalCount: 0, keys: [] };
    expect(formatRotationStatus(result)).toContain('All keys rotated within the last 90 days');
  });

  it('KRC12: OVERDUE chip for key >=90d but <180d', () => {
    const result = {
      days: 90, overdueCount: 1, criticalCount: 0,
      keys: [{
        id: 'aabbccdd-1111-0000-0000-000000000000', name: 'Overdue Key',
        lastRotatedAt: daysAgo(95), createdAt: daysAgo(200),
        daysSinceLastRotation: 95, disabled: false, isExpired: false,
      }],
    };
    const output = formatRotationStatus(result);
    expect(output).toContain('[OVERDUE]');
    expect(output).not.toContain('[CRITICAL]');
    expect(output).toContain('95d');
  });

  it('KRC13: CRITICAL chip for key >=180d', () => {
    const result = {
      days: 90, overdueCount: 1, criticalCount: 1,
      keys: [{
        id: 'aabbccdd-2222-0000-0000-000000000000', name: 'Critical Key',
        lastRotatedAt: daysAgo(185), createdAt: daysAgo(300),
        daysSinceLastRotation: 185, disabled: false, isExpired: false,
      }],
    };
    const output = formatRotationStatus(result);
    expect(output).toContain('[CRITICAL]');
    expect(output).toContain('185d');
  });

  it('KRC14: never-rotated key shows "never rotated" label', () => {
    const result = {
      days: 90, overdueCount: 1, criticalCount: 0,
      keys: [{
        id: 'aabbccdd-3333-0000-0000-000000000000', name: 'Fresh Key',
        lastRotatedAt: null, createdAt: daysAgo(95),
        daysSinceLastRotation: null, disabled: false, isExpired: false,
      }],
    };
    const output = formatRotationStatus(result);
    expect(output).toContain('never rotated');
  });

  it('KRC15: disabled+expired key shows DISABLED and EXPIRED tags', () => {
    const result = {
      days: 90, overdueCount: 1, criticalCount: 0,
      keys: [{
        id: 'aabbccdd-4444-0000-0000-000000000000', name: 'Bad Key',
        lastRotatedAt: daysAgo(100), createdAt: daysAgo(200),
        daysSinceLastRotation: 100, disabled: true, isExpired: true,
      }],
    };
    const output = formatRotationStatus(result);
    expect(output).toContain('DISABLED');
    expect(output).toContain('EXPIRED');
  });
});
