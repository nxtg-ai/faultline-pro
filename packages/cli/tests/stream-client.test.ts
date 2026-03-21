/**
 * Stream Client Tests (N-143) — SC1–SC15
 *
 * Validates: N-136 (faultline stream CLI command — SSE parser + formatter)
 *
 * Covers the two untested pure exports of cli/stream-client.ts:
 *   SC1–SC7  : parseSSEBody — all branches (empty, valid, multi-event,
 *              non-data filter, malformed JSON try/catch, mixed valid+malformed)
 *   SC8–SC15 : formatStreamResult — null-coalescing fallbacks not covered by
 *              ST1–ST5 (unknown provider, undefined overallRisk, undefined
 *              claimCount, unknown verdict icon, missing claim text, null
 *              verdict, confidenceScore denominator)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseSSEBody, formatStreamResult, streamScan, type StreamResult, type StreamEvent } from '../cli/stream-client.js';

// ---------------------------------------------------------------------------
// SC1–SC7 — parseSSEBody
// ---------------------------------------------------------------------------

describe('parseSSEBody', () => {
  it('SC1: empty string returns empty array', () => {
    const result = parseSSEBody('');
    expect(result).toEqual([]);
  });

  it('SC2: single valid data chunk returns one event', () => {
    const body = 'data: {"type":"start","claimCount":3,"provider":"mock"}';
    const result = parseSSEBody(body);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('start');
    expect(result[0].claimCount).toBe(3);
    expect(result[0].provider).toBe('mock');
  });

  it('SC3: multiple events separated by double newline all parsed', () => {
    const body = [
      'data: {"type":"start","claimCount":2,"provider":"mock"}',
      'data: {"type":"claim_verified","index":0}',
      'data: {"type":"complete","overallRisk":"low"}',
    ].join('\n\n');
    const result = parseSSEBody(body);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('start');
    expect(result[1].type).toBe('claim_verified');
    expect(result[2].type).toBe('complete');
  });

  it('SC4: lines not starting with "data: " are filtered out', () => {
    const body = [
      ': keep-alive comment',
      'event: ping',
      'data: {"type":"start","claimCount":1}',
    ].join('\n\n');
    const result = parseSSEBody(body);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('start');
  });

  it('SC5: malformed JSON chunk is silently dropped (try/catch branch)', () => {
    const body = [
      'data: {not valid json',
      'data: {"type":"complete","overallRisk":"low"}',
    ].join('\n\n');
    const result = parseSSEBody(body);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('complete');
  });

  it('SC6: all malformed chunks return empty array', () => {
    const body = [
      'data: {bad1',
      'data: {bad2',
    ].join('\n\n');
    const result = parseSSEBody(body);
    expect(result).toEqual([]);
  });

  it('SC7: error event type is preserved', () => {
    const body = 'data: {"type":"error","message":"Provider failed"}';
    const result = parseSSEBody(body);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error');
    expect(result[0].message).toBe('Provider failed');
  });
});

// ---------------------------------------------------------------------------
// SC8–SC15 — formatStreamResult fallback branches
// ---------------------------------------------------------------------------

describe('formatStreamResult — null-coalescing fallbacks', () => {
  it('SC8: provider undefined → shows "unknown" in header', () => {
    const result = formatStreamResult({
      events: [{ type: 'complete', overallRisk: 'low' }],
      overallRisk: 'low',
      claimCount: 0,
      // provider is omitted
    });
    expect(result).toContain('unknown provider');
  });

  it('SC9: overallRisk undefined → shows "UNKNOWN" in risk line', () => {
    const result = formatStreamResult({
      events: [],
      // overallRisk omitted
      claimCount: 0,
      provider: 'mock',
    });
    expect(result).toContain('Risk: UNKNOWN');
  });

  it('SC10: claimCount undefined → shows "Claims verified: 0"', () => {
    const result = formatStreamResult({
      events: [],
      overallRisk: 'low',
      // claimCount omitted
      provider: 'mock',
    });
    expect(result).toContain('Claims verified: 0');
  });

  it('SC11: unknown verdict status falls back to "?" icon', () => {
    // Covers VERDICT_ICONS[status] ?? '?' branch
    const result = formatStreamResult({
      events: [
        { type: 'claim_verified', index: 0, claim: { text: 'A claim.' }, verdict: { status: 'loading' } },
      ],
      overallRisk: 'low',
      claimCount: 1,
      provider: 'mock',
    });
    expect(result).toContain('? loading:');
  });

  it('SC12: missing claim text falls back to "(unknown claim)"', () => {
    // Covers ev.claim?.["text"] ?? "(unknown claim)" branch
    const result = formatStreamResult({
      events: [
        { type: 'claim_verified', index: 0, claim: {}, verdict: { status: 'supported' } },
      ],
      overallRisk: 'low',
      claimCount: 1,
      provider: 'mock',
    });
    expect(result).toContain('(unknown claim)');
  });

  it('SC13: null verdict falls back to "unverified" status', () => {
    // Covers ev.verdict?.["status"] ?? "unverified" branch
    const result = formatStreamResult({
      events: [
        { type: 'claim_verified', index: 0, claim: { text: 'A claim.' }, verdict: null },
      ],
      overallRisk: 'low',
      claimCount: 1,
      provider: 'mock',
    });
    expect(result).toContain('? unverified:');
  });

  it('SC14: claim text exactly 80 chars is NOT truncated', () => {
    const text80 = 'A'.repeat(80);
    const result = formatStreamResult({
      events: [{ type: 'claim_verified', index: 0, claim: { text: text80 }, verdict: { status: 'supported' } }],
      overallRisk: 'low', claimCount: 1, provider: 'mock',
    });
    expect(result).toContain(`"${text80}"`);
    expect(result).not.toContain('...');
  });

  it('SC15: claim text 81 chars IS truncated to 77 + "..."', () => {
    // Covers text.length > 80 → slice(0, 77) + '...' branch
    const text81 = 'B'.repeat(81);
    const result = formatStreamResult({
      events: [{ type: 'claim_verified', index: 0, claim: { text: text81 }, verdict: { status: 'supported' } }],
      overallRisk: 'low', claimCount: 1, provider: 'mock',
    });
    expect(result).toContain('"' + 'B'.repeat(77) + '..."');
    expect(result).not.toContain('B'.repeat(78));
  });
});

// ---------------------------------------------------------------------------
// SC16–SC20 — streamScan() HTTP client branches (lines 54-79 in stream-client.ts)
// ---------------------------------------------------------------------------

describe('streamScan — HTTP client branches', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('SC16: fetch throws network error → returns { events: [], error: message }', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network connection refused'));
    const result = await streamScan('http://localhost:3000', 'key', 'test text');
    expect(result.events).toEqual([]);
    expect(result.error).toBe('Network connection refused');
  });

  it('SC17: HTTP non-ok response with non-JSON body → returns "HTTP N" error', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockRejectedValue(new Error('not json')),
    } as unknown as Response);
    const result = await streamScan('http://localhost:3000', 'bad-key', 'test');
    expect(result.events).toEqual([]);
    expect(result.error).toBe('HTTP 401');
  });

  it('SC18: HTTP non-ok with JSON error body → uses error field from JSON', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({ error: 'Forbidden: quota exceeded' }),
    } as unknown as Response);
    const result = await streamScan('http://localhost:3000', 'key', 'test');
    expect(result.error).toBe('Forbidden: quota exceeded');
    expect(result.events).toEqual([]);
  });

  it('SC19: response contains error event → returns { events, error: errEvent.message }', async () => {
    const sseBody = 'data: {"type":"error","message":"Provider timeout"}';
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(sseBody),
    } as unknown as Response);
    const result = await streamScan('http://localhost:3000', 'key', 'test');
    expect(result.events).toHaveLength(1);
    expect(result.error).toBe('Provider timeout');
  });

  it('SC20: successful SSE response → parsed events, overallRisk, claimCount, provider', async () => {
    const sseBody = [
      'data: {"type":"start","claimCount":2,"provider":"mock"}',
      'data: {"type":"complete","overallRisk":"low"}',
    ].join('\n\n');
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(sseBody),
    } as unknown as Response);
    const result = await streamScan('http://localhost:3000', 'key', 'test text', 'mock');
    expect(result.events).toHaveLength(2);
    expect(result.overallRisk).toBe('low');
    expect(result.claimCount).toBe(2);
    expect(result.provider).toBe('mock');
    expect(result.error).toBeUndefined();
  });
});
