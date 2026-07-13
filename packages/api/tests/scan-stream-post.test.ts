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

  it('SPP11: consensus flag survives schema → claim_verified verdict carries consensus + providerVotes shape', async () => {
    // pipelineConfig.consensus=true must pass the body schema (additionalProperties:false)
    // and reach scan(). Using consensusProviders:['mock'] keeps it offline — the mock
    // provider lacks verifyClaimGrounded, so it surfaces as an unavailable vote
    // (providerCount 0), which still proves the richer verdict shape flows through.
    const { statusCode, body } = await postStream(server, {
      text: SCAN_TEXT,
      provider: 'mock',
      pipelineConfig: {
        extractionProvider: 'mock',
        consensus: true,
        consensusProviders: ['mock'],
      },
    });
    expect(statusCode).toBe(200);
    const events = parseSSE(body);
    const claimVerified = events.filter((e) => e.type === 'claim_verified');
    expect(claimVerified.length).toBeGreaterThan(0);
    const verdict = claimVerified[0]?.verdict as Record<string, unknown>;
    // Richer consensus shape reached the wire (additive contract with fw).
    expect(verdict.consensus).toBeDefined();
    expect(Array.isArray(verdict.providerVotes)).toBe(true);
    // LOCK B: mock has no grounded entry point → excluded from providerCount.
    expect((verdict.consensus as Record<string, unknown>).providerCount).toBe(0);
  });

  it('SPP12: consensus=false / absent → single-provider verdict shape (no consensus fields)', async () => {
    const { body } = await postStream(server, {
      text: SCAN_TEXT,
      provider: 'mock',
      pipelineConfig: { verificationProvider: 'mock' },
    });
    const claimVerified = parseSSE(body).filter((e) => e.type === 'claim_verified');
    expect(claimVerified.length).toBeGreaterThan(0);
    const verdict = claimVerified[0]?.verdict as Record<string, unknown>;
    expect(verdict.consensus).toBeUndefined();
    expect(verdict.providerVotes).toBeUndefined();
  });

  it('SPP13: CORS — hijacked stream carries access-control-* for an allowed browser Origin', async () => {
    // BLG-fp-20260713-A regression guard. @fastify/cors sets ACAO/ACAC via
    // reply.header() in an onRequest hook; after reply.hijack() those never
    // flush unless we carry reply.getHeaders() onto writeHead. Without the fix
    // curl/inject pass but the browser EventSource on faultline.nxtg.ai is
    // CORS-blocked. Assert the streamed response actually carries ACAO.
    const res = await server.inject({
      method: 'POST',
      url: '/scan/stream',
      headers: {
        'x-api-key': 'test-stream-key',
        'content-type': 'application/json',
        origin: 'https://faultline.nxtg.ai',
      },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    expect(res.headers['access-control-allow-origin']).toBe('https://faultline.nxtg.ai');
    expect(String(res.headers['access-control-allow-credentials'])).toBe('true');
    // Security headers the onSend hook would have added are also present.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('SPP14: CORS — GET /scan/stream also carries access-control-* for an allowed Origin', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-stream-key', origin: 'https://faultline.nxtg.ai' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://faultline.nxtg.ai');
  });

  it('SPP15: incremental delivery — events flush as produced, not buffered to the end (real socket, timed)', async () => {
    // inject() buffers the whole response, so it CANNOT distinguish "streamed
    // per event" from "buffered then sent in one .send()" — the bytes are
    // identical. Only a real socket with receive timestamps proves incremental
    // delivery. We drive scan()'s onClaimVerified with a real delay between the
    // two claims: if streaming works, the first claim_verified chunk arrives
    // ~immediately and 'complete' arrives ~2 delays later (large gap). If the
    // old buffered burst regressed back in, both arrive together at the end
    // (gap ~0). Assert the gap is clearly non-zero.
    const DELAY_MS = 80;
    const scanModule = await import('@nxtg/faultline/cli/scan.js');
    const mkClaim = (i: number) => ({ id: `c${i}`, text: `claim ${i}`, type: 'factual', importance: 'high' });
    const mkVerdict = () => ({ status: 'supported', confidence: 0.9, reasoning: 'ok', sources: [] });
    const spy = vi
      .spyOn(scanModule, 'scan')
      .mockImplementation((async (
        _text: string,
        _provider: unknown,
        _minConf: unknown,
        _rules: unknown,
        _onProgress: unknown,
        onClaimVerified?: (c: unknown, v: unknown, i: number, t: number) => void,
      ) => {
        onClaimVerified?.(mkClaim(0), mkVerdict(), 0, 2);
        await new Promise((r) => setTimeout(r, DELAY_MS));
        onClaimVerified?.(mkClaim(1), mkVerdict(), 1, 2);
        await new Promise((r) => setTimeout(r, DELAY_MS));
        return { claims: [mkClaim(0), mkClaim(1)], overallRisk: 'low' };
      }) as unknown as typeof scanModule.scan);

    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/scan/stream`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-stream-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: SCAN_TEXT, provider: 'mock' }),
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const t0 = Date.now();
    let firstClaimAt = -1;
    let completeAt = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const now = Date.now() - t0;
      if (firstClaimAt < 0 && chunk.includes('claim_verified')) firstClaimAt = now;
      if (chunk.includes('"type":"complete"')) completeAt = now;
    }

    expect(firstClaimAt).toBeGreaterThanOrEqual(0);
    expect(completeAt).toBeGreaterThanOrEqual(0);
    // Streamed: first claim arrives early, complete ~2×DELAY later. Buffered
    // regression would collapse this gap to ~0.
    expect(completeAt - firstClaimAt).toBeGreaterThan(DELAY_MS);

    spy.mockRestore();
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
    // BLG-fp-20260713-A: the raw engine error is NOT leaked to the client — a
    // generic client-safe message is emitted instead (raw goes to server logs).
    expect(errorEvent?.message).not.toContain('forced test error');
    expect(errorEvent?.message).toBeTruthy();

    spy.mockRestore();
  });
});
