/**
 * FR-1 — POST /scan/stream (SPP1–SPP10)
 * N-221
 *
 * SPP1   POST /scan/stream returns 200 with Content-Type text/event-stream
 * SPP2   emits start event with claimCount
 * SPP3   emits claim_verified events (one per verifiable claim)
 * SPP4   emits complete event with overallRisk
 * SPP5   missing text body → 400
 * SPP6   event sequence: start before any claim_verified; complete is last
 * SPP7   claim_verified indices form a 0-based contiguous sequence
 * SPP8   GET /scan/stream still works (no regression)
 * SPP9   POST with pipelineConfig → 200, SSE format preserved (FR-3 compat)
 * SPP10  scan error → error event emitted, connection still closes cleanly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

const SCAN_TEXT = 'The Eiffel Tower is located in Berlin. Water boils at 150 degrees Celsius.';

/** Parse raw SSE body into typed event objects. */
function parseSSE(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postStream(
  server: FastifyInstance,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; headers: Record<string, string | string[]>; body: string }> {
  const res = await server.inject({
    method: 'POST',
    url: '/scan/stream',
    headers: { 'x-api-key': 'test-stream-key', 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return { statusCode: res.statusCode, headers: res.headers as Record<string, string | string[]>, body: res.body };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('FR-1 — POST /scan/stream', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'test-stream-key';
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('SPP1: returns 200 with Content-Type text/event-stream', async () => {
    const { statusCode, headers } = await postStream(server, { text: SCAN_TEXT, provider: 'mock' });
    expect(statusCode).toBe(200);
    expect(String(headers['content-type'])).toContain('text/event-stream');
  });

  it('SPP2: emits start event with claimCount', async () => {
    const { body } = await postStream(server, { text: SCAN_TEXT, provider: 'mock' });
    const events = parseSSE(body);
    const start = events.find((e) => e.type === 'start');
    expect(start).toBeDefined();
    expect(typeof start?.claimCount).toBe('number');
  });

  it('SPP3: emits claim_verified events (one per verifiable claim)', async () => {
    const { body } = await postStream(server, { text: SCAN_TEXT, provider: 'mock' });
    const events = parseSSE(body);
    const startEvent = events.find((e) => e.type === 'start') as Record<string, unknown> | undefined;
    const verified = events.filter((e) => e.type === 'claim_verified');
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.length).toBe(startEvent?.claimCount);
  });

  it('SPP4: emits complete event with overallRisk', async () => {
    const { body } = await postStream(server, { text: SCAN_TEXT, provider: 'mock' });
    const events = parseSSE(body);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(['low', 'medium', 'high', 'critical']).toContain(complete?.overallRisk);
  });

  it('SPP5: missing text → 400', async () => {
    const { statusCode } = await postStream(server, { provider: 'mock' });
    expect(statusCode).toBe(400);
  });

  it('SPP6: start arrives before claim_verified; complete is last', async () => {
    const { body } = await postStream(server, { text: SCAN_TEXT, provider: 'mock' });
    const events = parseSSE(body);
    const types = events.map((e) => e.type);
    const startIdx = types.indexOf('start');
    const completeIdx = types.lastIndexOf('complete');
    const firstVerifiedIdx = types.indexOf('claim_verified');
    expect(startIdx).toBe(0);
    expect(firstVerifiedIdx).toBeGreaterThan(startIdx);
    expect(completeIdx).toBe(types.length - 1);
  });

  it('SPP7: claim_verified indices are 0-based and contiguous', async () => {
    const { body } = await postStream(server, { text: SCAN_TEXT, provider: 'mock' });
    const events = parseSSE(body);
    const indices = events
      .filter((e) => e.type === 'claim_verified')
      .map((e) => e.index as number);
    for (let i = 0; i < indices.length; i++) {
      expect(indices[i]).toBe(i);
    }
  });

  it('SPP8: GET /scan/stream still works (no regression)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-stream-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSSE(res.body);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
  });

  it('SPP9: pipelineConfig accepted → 200, SSE format preserved', async () => {
    const { statusCode, body } = await postStream(server, {
      text: SCAN_TEXT,
      provider: 'mock',
      pipelineConfig: { extractionProvider: 'mock', verificationProvider: 'mock' },
    });
    expect(statusCode).toBe(200);
    const events = parseSSE(body);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
  });

  it('SPP10: scan error → error event emitted', async () => {
    // Trigger an error by mocking scan — use a provider that throws
    // The simplest way: pass a provider name that's valid in schema but has no key
    // With mock provider this won't error. Use vi.spyOn on the module instead.
    const scanModule = await import('@nxtg/faultline/cli/scan.js');
    const spy = vi.spyOn(scanModule, 'scan').mockRejectedValueOnce(new Error('forced test error'));

    const { body } = await postStream(server, { text: SCAN_TEXT, provider: 'mock' });
    const events = parseSSE(body);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.message).toContain('forced test error');

    spy.mockRestore();
  });
});
