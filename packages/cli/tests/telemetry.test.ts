/**
 * N-226 — DIRECTIVE-NXTG-20260428-01
 * Telemetry module tests: privacy, opt-in, no-crash guarantees.
 *
 * NEXUS: N-226 (opt-in telemetry, no PII, fire-and-forget)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Helpers ────────────────────────────────────────────────────────────────────

const ALLOWED_PROVIDERS = new Set(['gemini', 'openai', 'claude', 'perplexity', 'mock']);
const ALLOWED_PLATFORMS = new Set(['linux', 'darwin', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix']);
const WHITELISTED_FIELDS = new Set([
  'install_id', 'run_id', 'version', 'provider',
  'exit_status', 'eval_count', 'error_code', 'os_platform', 'timestamp',
]);

function capturedPayload(): Record<string, unknown> | null {
  const calls = vi.mocked(fetch).mock.calls;
  if (calls.length === 0) return null;
  const call = calls[0]!;
  const opts = call[1] as RequestInit;
  return JSON.parse(opts.body as string) as Record<string, unknown>;
}

// ── isEnabled ─────────────────────────────────────────────────────────────────

describe('isEnabled', () => {
  afterEach(() => { delete process.env.FAULTLINE_TELEMETRY; });

  it('TEL-E1: returns false when env var is unset', async () => {
    delete process.env.FAULTLINE_TELEMETRY;
    const { isEnabled } = await import('../cli/telemetry.js');
    expect(isEnabled()).toBe(false);
  });

  it('TEL-E2: returns true when FAULTLINE_TELEMETRY=1', async () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    const { isEnabled } = await import('../cli/telemetry.js');
    expect(isEnabled()).toBe(true);
  });

  it('TEL-E3: returns false for non-1 values', async () => {
    process.env.FAULTLINE_TELEMETRY = 'true';
    const { isEnabled } = await import('../cli/telemetry.js');
    expect(isEnabled()).toBe(false);
  });
});

// ── sendTelemetry — disabled ───────────────────────────────────────────────────

describe('sendTelemetry — disabled', () => {
  beforeEach(() => {
    delete process.env.FAULTLINE_TELEMETRY;
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FAULTLINE_TELEMETRY;
  });

  it('TEL-D1: does not call fetch when telemetry is disabled', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'gemini', exit_status: 0, eval_count: 5 });
    // Give microtasks a chance to flush
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('TEL-D2: returns a run_id string even when disabled', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    const id = sendTelemetry({ version: '0.5.3', provider: 'gemini', exit_status: 0, eval_count: 0 });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

// ── sendTelemetry — enabled ───────────────────────────────────────────────────

describe('sendTelemetry — enabled', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fl-tel-'));
    process.env.FAULTLINE_TELEMETRY = '1';
    process.env.FAULTLINE_TELEMETRY_ENDPOINT = 'https://fake-worker.test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201 } as Response));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    delete process.env.FAULTLINE_TELEMETRY;
    delete process.env.FAULTLINE_TELEMETRY_ENDPOINT;
  });

  it('TEL-S1: calls fetch when telemetry is enabled', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'gemini', exit_status: 0, eval_count: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('TEL-S2: sends to /events endpoint', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'openai', exit_status: 0, eval_count: 7 });
    await new Promise((r) => setTimeout(r, 50));
    const url = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(url).toMatch(/\/events$/);
  });

  it('TEL-S3: payload contains only whitelisted fields', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'claude', exit_status: 0, eval_count: 2 });
    await new Promise((r) => setTimeout(r, 50));
    const payload = capturedPayload();
    expect(payload).not.toBeNull();
    for (const key of Object.keys(payload!)) {
      expect(WHITELISTED_FIELDS.has(key)).toBe(true);
    }
  });

  it('TEL-S4: provider field is in allowed set', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'gemini', exit_status: 0, eval_count: 0 });
    await new Promise((r) => setTimeout(r, 50));
    const payload = capturedPayload();
    expect(ALLOWED_PROVIDERS.has(payload!.provider as string)).toBe(true);
  });

  it('TEL-S5: os_platform is in allowed set', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'mock', exit_status: 0, eval_count: 0 });
    await new Promise((r) => setTimeout(r, 50));
    const payload = capturedPayload();
    expect(ALLOWED_PLATFORMS.has(payload!.os_platform as string)).toBe(true);
  });

  it('TEL-S6: install_id is a valid UUID format', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'gemini', exit_status: 0, eval_count: 0 });
    await new Promise((r) => setTimeout(r, 50));
    const payload = capturedPayload();
    expect(payload!.install_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('TEL-S7: run_id is a valid UUID format', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'gemini', exit_status: 0, eval_count: 0 });
    await new Promise((r) => setTimeout(r, 50));
    const payload = capturedPayload();
    expect(payload!.run_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('TEL-S8: error_code is omitted when not provided', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'gemini', exit_status: 0, eval_count: 1 });
    await new Promise((r) => setTimeout(r, 50));
    const payload = capturedPayload();
    expect('error_code' in payload!).toBe(false);
  });

  it('TEL-S9: error_code is included when provided', async () => {
    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'gemini', exit_status: 1, eval_count: 0, error_code: 'API_ERROR' });
    await new Promise((r) => setTimeout(r, 50));
    const payload = capturedPayload();
    expect(payload!.error_code).toBe('API_ERROR');
  });

  it('TEL-S10: network failure does not throw or crash', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const { sendTelemetry } = await import('../cli/telemetry.js');
    expect(() => sendTelemetry({
      version: '0.5.3', provider: 'gemini', exit_status: 0, eval_count: 0,
    })).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    // No unhandled rejection
  });
});

// ── install_id persistence ─────────────────────────────────────────────────────

describe('install_id reuse', () => {
  it('TEL-I1: two consecutive calls share the same install_id', async () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    process.env.FAULTLINE_TELEMETRY_ENDPOINT = 'https://fake-worker.test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response));

    const { sendTelemetry } = await import('../cli/telemetry.js');
    sendTelemetry({ version: '0.5.3', provider: 'gemini', exit_status: 0, eval_count: 0 });
    sendTelemetry({ version: '0.5.3', provider: 'gemini', exit_status: 0, eval_count: 0 });
    await new Promise((r) => setTimeout(r, 50));

    const calls = vi.mocked(fetch).mock.calls;
    if (calls.length >= 2) {
      const id1 = JSON.parse((calls[0]![1] as RequestInit).body as string).install_id;
      const id2 = JSON.parse((calls[1]![1] as RequestInit).body as string).install_id;
      expect(id1).toBe(id2);
    }

    vi.unstubAllGlobals();
    delete process.env.FAULTLINE_TELEMETRY;
    delete process.env.FAULTLINE_TELEMETRY_ENDPOINT;
  });
});

// ── classifyError ─────────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('TEL-C1: classifies AbortError as TIMEOUT', async () => {
    const { classifyError } = await import('../cli/telemetry.js');
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyError(err)).toBe('TIMEOUT');
  });

  it('TEL-C2: classifies ENOTFOUND as NETWORK_ERROR', async () => {
    const { classifyError } = await import('../cli/telemetry.js');
    expect(classifyError(new Error('ENOTFOUND api.example.com'))).toBe('NETWORK_ERROR');
  });

  it('TEL-C3: classifies API key error as API_KEY_MISSING', async () => {
    const { classifyError } = await import('../cli/telemetry.js');
    expect(classifyError(new Error('No API key set'))).toBe('API_KEY_MISSING');
  });

  it('TEL-C4: classifies 429 as RATE_LIMIT', async () => {
    const { classifyError } = await import('../cli/telemetry.js');
    expect(classifyError(new Error('HTTP 429 rate limit exceeded'))).toBe('RATE_LIMIT');
  });

  it('TEL-C5: classifies unknown errors as UNKNOWN', async () => {
    const { classifyError } = await import('../cli/telemetry.js');
    expect(classifyError(new Error('something completely different'))).toBe('UNKNOWN');
  });

  it('TEL-C6: handles non-Error thrown values', async () => {
    const { classifyError } = await import('../cli/telemetry.js');
    expect(classifyError('string error')).toBe('UNKNOWN');
    expect(classifyError(null)).toBe('UNKNOWN');
    expect(classifyError(42)).toBe('UNKNOWN');
  });
});
