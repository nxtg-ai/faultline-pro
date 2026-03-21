/**
 * N-92 — faultline keys CLI command
 *
 * KC1–KC5   keys-client formatters (pure unit — no fetch)
 * KC6–KC15  main(['keys', ...]) integration using vi.mock on keys-client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { main } from '../cli/index.js';
import {
  formatKeyList,
  formatDormantList,
  formatExpiringSoonList,
  formatRotateResult,
  type KeyEntry,
} from '../cli/keys-client.js';

// ── Formatter unit tests (no fetch) ─────────────────────────────────────────

const SAMPLE_KEY: KeyEntry = {
  id: 'abc12345-0000-0000-0000-000000000001',
  name: 'Test Key',
  permissions: ['scan'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('keys-client formatters', () => {
  it('KC1: formatKeyList — empty array returns "No API keys found."', () => {
    expect(formatKeyList([])).toBe('No API keys found.');
  });

  it('KC2: formatKeyList — shows id prefix, name, permissions, created', () => {
    const out = formatKeyList([SAMPLE_KEY]);
    expect(out).toContain('abc12345');
    expect(out).toContain('Test Key');
    expect(out).toContain('scan');
    expect(out).toContain('2026-01-01');
  });

  it('KC3: formatDormantList — zero count shows threshold message', () => {
    const out = formatDormantList({ days: 30, count: 0, keys: [] });
    expect(out).toContain('30');
    expect(out).toContain('No dormant');
  });

  it('KC4: formatExpiringSoonList — zero count shows days', () => {
    const out = formatExpiringSoonList({ days: 7, count: 0, keys: [] });
    expect(out).toContain('7');
    expect(out).toContain('No keys expiring');
  });

  it('KC5: formatRotateResult — error path returns error string', () => {
    const out = formatRotateResult({ id: 'x', newKey: '', previousKey: '', previousKeyExpiresAt: '', gracePeriodHours: 24, message: '', error: 'Not found' });
    expect(out).toContain('Error: Not found');
  });
});

// ── CLI integration tests (mock keys-client) ─────────────────────────────────

vi.mock('../cli/keys-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/keys-client.js')>();
  return {
    ...actual,
    listKeys: vi.fn(),
    getDormantKeys: vi.fn(),
    getExpiringSoonKeys: vi.fn(),
    rotateKey: vi.fn(),
  };
});

const BASE_ARGS = ['keys', 'list', '--api-key', 'test-key', '--api-url', 'http://localhost:3000'];

describe('faultline keys — CLI integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const client = await import('../cli/keys-client.js');
    vi.mocked(client.listKeys).mockResolvedValue({ keys: [SAMPLE_KEY] });
    vi.mocked(client.getDormantKeys).mockResolvedValue({ days: 30, count: 1, keys: [SAMPLE_KEY] });
    vi.mocked(client.getExpiringSoonKeys).mockResolvedValue({ days: 7, count: 1, keys: [{ ...SAMPLE_KEY, expiresAt: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString() }] });
    vi.mocked(client.rotateKey).mockResolvedValue({
      id: SAMPLE_KEY.id, newKey: 'newkey123', previousKey: 'oldkey456',
      previousKeyExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      gracePeriodHours: 24, message: 'Rotated.',
    });
  });

  it('KC6: keys list — returns 0 and lists keys', async () => {
    const { exitCode, output } = await main(BASE_ARGS);
    expect(exitCode).toBe(0);
    expect(output).toContain('Test Key');
  });

  it('KC7: keys list — calls listKeys with api-url and api-key', async () => {
    const client = await import('../cli/keys-client.js');
    await main(BASE_ARGS);
    expect(vi.mocked(client.listKeys)).toHaveBeenCalledWith('http://localhost:3000', 'test-key');
  });

  it('KC8: keys dormant — calls getDormantKeys with days', async () => {
    const client = await import('../cli/keys-client.js');
    const { exitCode, output } = await main(['keys', 'dormant', '--days', '14', '--api-key', 'test-key', '--api-url', 'http://localhost:3000']);
    expect(exitCode).toBe(0);
    expect(vi.mocked(client.getDormantKeys)).toHaveBeenCalledWith('http://localhost:3000', 'test-key', 14);
    expect(output).toContain('Dormant');
  });

  it('KC9: keys expiring — calls getExpiringSoonKeys with days', async () => {
    const client = await import('../cli/keys-client.js');
    const { exitCode } = await main(['keys', 'expiring', '--days', '3', '--api-key', 'test-key', '--api-url', 'http://localhost:3000']);
    expect(exitCode).toBe(0);
    expect(vi.mocked(client.getExpiringSoonKeys)).toHaveBeenCalledWith('http://localhost:3000', 'test-key', 3);
  });

  it('KC10: keys rotate <id> — calls rotateKey and shows new key', async () => {
    const client = await import('../cli/keys-client.js');
    const { exitCode, output } = await main(['keys', 'rotate', SAMPLE_KEY.id, '--api-key', 'test-key', '--api-url', 'http://localhost:3000']);
    expect(exitCode).toBe(0);
    expect(vi.mocked(client.rotateKey)).toHaveBeenCalledWith('http://localhost:3000', 'test-key', SAMPLE_KEY.id);
    expect(output).toContain('newkey123');
  });

  it('KC11: missing --api-key and env var → exitCode 1 with helpful message', async () => {
    const savedEnv = process.env.FAULTLINE_API_KEY;
    delete process.env.FAULTLINE_API_KEY;
    const { exitCode, output } = await main(['keys', 'list', '--api-url', 'http://localhost:3000']);
    expect(exitCode).toBe(1);
    expect(output).toContain('api-key');
    process.env.FAULTLINE_API_KEY = savedEnv;
  });

  it('KC12: keys rotate without <id> → exitCode 1 with usage hint', async () => {
    const { exitCode, output } = await main(['keys', 'rotate', '--api-key', 'test-key']);
    expect(exitCode).toBe(1);
    expect(output).toContain('rotate <key-id>');
  });

  it('KC13: unknown keys subcommand → exitCode 1 with usage', async () => {
    const { exitCode, output } = await main(['keys', 'unknown-sub', '--api-key', 'test-key']);
    expect(exitCode).toBe(1);
    expect(output).toContain('Usage:');
  });

  it('KC14: listKeys returns error → exitCode 1', async () => {
    const client = await import('../cli/keys-client.js');
    vi.mocked(client.listKeys).mockResolvedValue({ keys: [], error: 'Unauthorized' });
    const { exitCode, output } = await main(BASE_ARGS);
    expect(exitCode).toBe(1);
    expect(output).toContain('Unauthorized');
  });

  it('KC15: FAULTLINE_API_KEY env var used when no --api-key flag', async () => {
    const client = await import('../cli/keys-client.js');
    process.env.FAULTLINE_API_KEY = 'env-key';
    process.env.FAULTLINE_API_URL = 'http://env-host:3000';
    await main(['keys', 'list']);
    expect(vi.mocked(client.listKeys)).toHaveBeenCalledWith('http://env-host:3000', 'env-key');
    delete process.env.FAULTLINE_API_KEY;
    delete process.env.FAULTLINE_API_URL;
  });
});
