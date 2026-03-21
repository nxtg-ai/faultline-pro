/**
 * N-136 — faultline stream CLI command (ST1–ST15)
 *
 * formatStreamResult unit tests (ST1–ST5):
 *   ST1:  error result renders "Error: <message>"
 *   ST2:  successful result includes provider name in header
 *   ST3:  result with no claim_verified events shows "No claims found."
 *   ST4:  supported claim renders ✓ icon and "supported" label
 *   ST5:  claim text longer than 80 chars is truncated with "..."
 *
 * faultline stream CLI integration (ST6–ST15):
 *   ST6:  missing --api-key and no env var → exitCode 1 with auth error
 *   ST7:  missing text argument → exitCode 1 with usage error
 *   ST8:  streamScan called with correct apiUrl, apiKey, text, provider
 *   ST9:  streamScan returns error → exitCode 1 with error message
 *   ST10: successful stream → exitCode 0 with formatted output
 *   ST11: FAULTLINE_API_KEY and FAULTLINE_API_URL env vars used as fallback
 *   ST12: --provider flag passed through to streamScan
 *   ST13: default provider is "mock" when --provider is omitted
 *   ST14: output contains "Risk:" line on success
 *   ST15: --text flag accepted as alternative to positional text argument
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { main } from '../cli/index.js';
import { formatStreamResult, type StreamResult } from '../cli/stream-client.js';

// ── Formatter unit tests (no fetch) ─────────────────────────────────────────

const SAMPLE_RESULT: StreamResult = {
  events: [
    { type: 'start',          claimCount: 2, provider: 'mock' },
    { type: 'claim_verified', index: 0, claim: { id: 'c1', text: 'Water boils at 100 degrees Celsius.' }, verdict: { status: 'supported' } },
    { type: 'claim_verified', index: 1, claim: { id: 'c2', text: 'The sky is green.'                   }, verdict: { status: 'contradicted' } },
    { type: 'complete',       overallRisk: 'low', claimCount: 2 },
  ],
  provider:    'mock',
  claimCount:  2,
  overallRisk: 'low',
};

describe('formatStreamResult — unit tests (ST1–ST5)', () => {
  it('ST1: error result renders "Error: <message>"', () => {
    const out = formatStreamResult({ events: [], error: 'network timeout' });
    expect(out).toBe('Error: network timeout');
  });

  it('ST2: successful result includes provider name in header', () => {
    const out = formatStreamResult(SAMPLE_RESULT);
    expect(out).toContain('mock');
  });

  it('ST3: result with no claim_verified events shows "No claims found."', () => {
    const out = formatStreamResult({
      events: [
        { type: 'start', claimCount: 0, provider: 'mock' },
        { type: 'complete', overallRisk: 'low', claimCount: 0 },
      ],
      provider:    'mock',
      claimCount:  0,
      overallRisk: 'low',
    });
    expect(out).toContain('No claims found.');
  });

  it('ST4: supported claim renders ✓ icon and "supported" label', () => {
    const out = formatStreamResult(SAMPLE_RESULT);
    expect(out).toContain('✓');
    expect(out).toContain('supported');
  });

  it('ST5: claim text longer than 80 chars is truncated with "..."', () => {
    const longText = 'A'.repeat(100);
    const result: StreamResult = {
      events: [
        { type: 'claim_verified', index: 0, claim: { id: 'c1', text: longText }, verdict: { status: 'unverified' } },
      ],
      provider:    'mock',
      claimCount:  1,
      overallRisk: 'unknown',
    };
    const out = formatStreamResult(result);
    expect(out).toContain('...');
    // Truncated to 77 + "..." = 80
    expect(out).not.toContain(longText);
  });
});

// ── CLI integration tests (mock streamScan) ──────────────────────────────────

vi.mock('../cli/stream-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/stream-client.js')>();
  return {
    ...actual,
    streamScan: vi.fn(),
  };
});

const BASE_ARGS = ['stream', 'Check this claim', '--api-key', 'test-key', '--api-url', 'http://localhost:3000'];

describe('faultline stream — CLI integration (ST6–ST15)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const client = await import('../cli/stream-client.js');
    vi.mocked(client.streamScan).mockResolvedValue(SAMPLE_RESULT);
  });

  afterEach(() => {
    delete process.env.FAULTLINE_API_KEY;
    delete process.env.FAULTLINE_API_URL;
  });

  it('ST6: missing --api-key and no env var → exitCode 1 with auth error', async () => {
    const { exitCode, output } = await main(['stream', 'some text', '--api-url', 'http://localhost:3000']);
    expect(exitCode).toBe(1);
    expect(output).toContain('api-key');
  });

  it('ST7: missing text argument → exitCode 1 with usage error', async () => {
    const { exitCode, output } = await main(['stream', '--api-key', 'test-key']);
    expect(exitCode).toBe(1);
    expect(output).toContain('Error:');
    expect(output).toContain('text');
  });

  it('ST8: streamScan called with correct apiUrl, apiKey, text, provider', async () => {
    const client = await import('../cli/stream-client.js');
    await main(BASE_ARGS);
    expect(vi.mocked(client.streamScan)).toHaveBeenCalledWith(
      'http://localhost:3000', 'test-key', 'Check this claim', 'mock',
    );
  });

  it('ST9: streamScan returns error → exitCode 1 with error message', async () => {
    const client = await import('../cli/stream-client.js');
    vi.mocked(client.streamScan).mockResolvedValue({ events: [], error: 'Unauthorized' });
    const { exitCode, output } = await main(BASE_ARGS);
    expect(exitCode).toBe(1);
    expect(output).toContain('Unauthorized');
  });

  it('ST10: successful stream → exitCode 0 with formatted output', async () => {
    const { exitCode, output } = await main(BASE_ARGS);
    expect(exitCode).toBe(0);
    expect(output.length).toBeGreaterThan(0);
  });

  it('ST11: FAULTLINE_API_KEY and FAULTLINE_API_URL env vars used as fallback', async () => {
    const client = await import('../cli/stream-client.js');
    process.env.FAULTLINE_API_KEY = 'env-key';
    process.env.FAULTLINE_API_URL = 'http://env-host:9000';
    await main(['stream', 'Check this claim']);
    expect(vi.mocked(client.streamScan)).toHaveBeenCalledWith('http://env-host:9000', 'env-key', 'Check this claim', 'mock');
  });

  it('ST12: --provider flag passed through to streamScan', async () => {
    const client = await import('../cli/stream-client.js');
    await main(['stream', 'Check this claim', '--api-key', 'test-key', '--provider', 'gemini']);
    expect(vi.mocked(client.streamScan)).toHaveBeenCalledWith(
      expect.any(String), 'test-key', 'Check this claim', 'gemini',
    );
  });

  it('ST13: default provider is "mock" when --provider is omitted', async () => {
    const client = await import('../cli/stream-client.js');
    await main(['stream', 'Check this claim', '--api-key', 'test-key']);
    expect(vi.mocked(client.streamScan)).toHaveBeenCalledWith(
      expect.any(String), 'test-key', 'Check this claim', 'mock',
    );
  });

  it('ST14: output contains "Risk:" line on success', async () => {
    const { output } = await main(BASE_ARGS);
    expect(output).toContain('Risk:');
  });

  it('ST15: --text flag accepted as alternative to positional text argument', async () => {
    const client = await import('../cli/stream-client.js');
    await main(['stream', '--text', 'Check via flag', '--api-key', 'test-key']);
    expect(vi.mocked(client.streamScan)).toHaveBeenCalledWith(
      expect.any(String), 'test-key', 'Check via flag', 'mock',
    );
  });
});
