/**
 * N-104 — `faultline keys prune` CLI command
 *
 * KKP1–KKP10  getKeysPrunePreview / pruneKeys unit: dry-run preview shape,
 *             empty result, API error forwarding, actual delete shape,
 *             days parameter propagation, confirm flag routing.
 * KKP11–KKP15 Formatter tests: formatPrunePreview and formatPruneResult —
 *             empty state, key list, dry-run hint, confirm output, error passthrough.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getKeysPrunePreview, pruneKeys, formatPrunePreview, formatPruneResult } from '../cli/keys-client.js';

const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

function mockOkResponse(body: unknown) {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function mockError(status: number, msg: string) {
  global.fetch = vi.fn().mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => JSON.stringify({ error: msg }),
  } as unknown as Response);
}

function makeKey(overrides: { id?: string; name?: string; createdAt?: string; lastUsedAt?: string } = {}) {
  return {
    id:          overrides.id          ?? 'aabbccdd-0000-0000-0000-000000000000',
    name:        overrides.name        ?? 'Dormant Key',
    permissions: ['scan'],
    createdAt:   overrides.createdAt   ?? daysAgo(100),
    lastUsedAt:  overrides.lastUsedAt  ?? null,
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('getKeysPrunePreview — unit', () => {
  it('KKP1: returns count and keys from GET /keys/dormant', async () => {
    const key = makeKey();
    mockOkResponse({ days: 90, count: 1, keys: [key] });
    const result = await getKeysPrunePreview('http://x', 'k', 90);
    expect(result.error).toBeUndefined();
    expect(result.count).toBe(1);
    expect(result.keys).toHaveLength(1);
    expect(result.days).toBe(90);
  });

  it('KKP2: empty store — count 0, keys []', async () => {
    mockOkResponse({ days: 90, count: 0, keys: [] });
    const result = await getKeysPrunePreview('http://x', 'k', 90);
    expect(result.count).toBe(0);
    expect(result.keys).toHaveLength(0);
  });

  it('KKP3: API error forwarded as result.error', async () => {
    mockError(403, 'Forbidden');
    const result = await getKeysPrunePreview('http://x', 'k', 90);
    expect(result.error).toBe('Forbidden');
    expect(result.keys).toHaveLength(0);
  });

  it('KKP4: days parameter passed as query string', async () => {
    mockOkResponse({ days: 30, count: 0, keys: [] });
    await getKeysPrunePreview('http://x', 'k', 30);
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('days=30');
  });

  it('KKP5: multiple dormant keys returned correctly', async () => {
    const keys = [makeKey({ id: 'aaa', name: 'Key A' }), makeKey({ id: 'bbb', name: 'Key B' })];
    mockOkResponse({ days: 90, count: 2, keys });
    const result = await getKeysPrunePreview('http://x', 'k', 90);
    expect(result.count).toBe(2);
    expect(result.keys).toHaveLength(2);
  });
});

describe('pruneKeys — unit', () => {
  it('KKP6: returns deleted count and ids from POST /keys/bulk-delete', async () => {
    mockOkResponse({ deleted: 2, ids: ['aaa', 'bbb'] });
    const result = await pruneKeys('http://x', 'k', 90);
    expect(result.error).toBeUndefined();
    expect(result.deleted).toBe(2);
    expect(result.ids).toEqual(['aaa', 'bbb']);
    expect(result.days).toBe(90);
  });

  it('KKP7: zero deleted when nothing dormant', async () => {
    mockOkResponse({ deleted: 0, ids: [] });
    const result = await pruneKeys('http://x', 'k', 90);
    expect(result.deleted).toBe(0);
    expect(result.ids).toHaveLength(0);
  });

  it('KKP8: API error forwarded as result.error', async () => {
    mockError(403, 'Forbidden');
    const result = await pruneKeys('http://x', 'k', 90);
    expect(result.error).toBe('Forbidden');
    expect(result.deleted).toBe(0);
  });

  it('KKP9: sends POST with days in request body', async () => {
    mockOkResponse({ deleted: 0, ids: [] });
    await pruneKeys('http://x', 'k', 45);
    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ days: 45 });
  });

  it('KKP10: days value preserved in result', async () => {
    mockOkResponse({ deleted: 1, ids: ['abc'] });
    const result = await pruneKeys('http://x', 'k', 60);
    expect(result.days).toBe(60);
  });
});

// ── Formatter tests ───────────────────────────────────────────────────────────

describe('formatPrunePreview — formatter', () => {
  it('KKP11: empty — all-clear message with nothing-to-prune hint', () => {
    const result = { days: 90, count: 0, keys: [] };
    const output = formatPrunePreview(result);
    expect(output).toContain('Nothing to prune');
    expect(output).not.toContain('DRY RUN');
  });

  it('KKP12: shows DRY RUN header and key list', () => {
    const key = makeKey({ name: 'Stale Key', lastUsedAt: daysAgo(100) });
    const result = { days: 90, count: 1, keys: [key] };
    const output = formatPrunePreview(result);
    expect(output).toContain('DRY RUN');
    expect(output).toContain('Stale Key');
    expect(output).toContain('would delete 1 dormant key');
  });

  it('KKP13: includes --confirm hint', () => {
    const key = makeKey();
    const result = { days: 90, count: 1, keys: [key] };
    expect(formatPrunePreview(result)).toContain('--confirm');
  });
});

describe('formatPruneResult — formatter', () => {
  it('KKP14: zero deleted — nothing pruned message', () => {
    const result = { days: 90, deleted: 0, ids: [] };
    expect(formatPruneResult(result)).toContain('Nothing pruned');
  });

  it('KKP15: shows deleted count and ID list', () => {
    const result = { days: 90, deleted: 2, ids: ['aabbccdd-0001', 'eeffgghh-0002'] };
    const output = formatPruneResult(result);
    expect(output).toContain('Pruned 2 dormant keys');
    expect(output).toContain('aabbccdd');
    expect(output).toContain('eeffgghh');
  });
});
