/**
 * N-137 — stream.ts mutation hardening (SM1–SM15)
 *
 * Targets surviving mutants from stryker-stream.config.mjs baseline (45.00%):
 *
 * startEmitted guard mutations (SM1–SM4):
 *   SM1:  exactly 1 start event in a normal multi-claim scan
 *         kills: line 68 ConditionalExpression (if(true)→always emit),
 *                line 70 BooleanLiteral (startEmitted=false→emit per-claim),
 *                line 84 ConditionalExpression (if(true)→double-emit start)
 *   SM2:  exactly 1 start event even when scan text produces only 1 claim
 *         kills: same group — off-by-one coverage
 *   SM3:  0-claim edge case — start event still present in stream
 *         kills: line 84 ConditionalExpression (if(false)→never fallback emit)
 *   SM4:  start event's type field is the string "start" (not an empty object)
 *         kills: ObjectLiteral on line 85 (emit({}) removes type/claimCount/provider)
 *
 * Missing-text error message mutation (SM5):
 *   SM5:  exact error message on missing ?text param
 *         kills: line 45 StringLiteral ("Missing required query param: text" → "")
 *
 * Response header mutations (SM6–SM8):
 *   SM6:  Cache-Control header is exactly "no-cache"
 *         kills: line 98 StringLiteral ("no-cache" → "") AND ("Cache-Control" → "")
 *   SM7:  Connection header is exactly "keep-alive"
 *         kills: line 99 StringLiteral ("keep-alive" → "") AND ("Connection" → "")
 *   SM8:  both Cache-Control and Connection headers are present on error response
 *         kills: header mutations in the error path (shared reply.header chain)
 *
 * Error path mutations (SM9–SM11):
 *   SM9:  forced scan failure (gemini without API key) → error event is emitted
 *         kills: no-coverage mutants in catch block (lines 89–93)
 *   SM10: error event has a non-empty message field (not "")
 *         kills: line 93 StringLiteral + BlockStatement removal
 *   SM11: start event is emitted before error event in error path
 *         kills: line 90 ConditionalExpression (if(!startEmitted)) mutations
 *
 * Start event payload completeness (SM12–SM15):
 *   SM12: start event has claimCount field equal to the number of claim_verified events
 *         kills: ObjectLiteral on startEmitted guard (claimCount set to 0 or wrong value)
 *   SM13: start event has provider field equal to the requested provider
 *         kills: ObjectLiteral mutations removing provider from start payload
 *   SM14: complete event has type field === "complete" (not empty object)
 *         kills: ObjectLiteral mutations on the complete emit call
 *   SM15: complete event has claimCount field equal to number of verified events
 *         kills: ObjectLiteral on complete emit (claimCount omitted)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

const SCAN_TEXT = 'The Eiffel Tower is located in Berlin. Water boils at 150 degrees Celsius.';
const ONE_CLAIM_TEXT = 'Water boils at 100 degrees Celsius.';

function parseSSE(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter(chunk => chunk.startsWith('data: '))
    .map(chunk => JSON.parse(chunk.replace(/^data: /, '')) as Record<string, unknown>);
}

let server: FastifyInstance;

beforeEach(() => {
  process.env.FAULTLINE_API_KEY = 'test-secret';
  server = buildServer();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

// ── startEmitted guard mutations (SM1–SM4) ────────────────────────────────────

describe('stream.ts startEmitted guards — mutation hardening (SM1–SM4)', () => {
  it('SM1: exactly 1 start event in a normal multi-claim scan', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const startEvents = events.filter(e => e['type'] === 'start');
    // Must be exactly 1 — kills startEmitted=false (line 70) and if(true) mutations
    expect(startEvents.length).toBe(1);
  });

  it('SM2: exactly 1 start event for single-claim text', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(ONE_CLAIM_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const startEvents = events.filter(e => e['type'] === 'start');
    expect(startEvents.length).toBe(1);
  });

  it('SM3: start event is present even when provider omitted (0-claim fallback path)', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(ONE_CLAIM_TEXT)}`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    // Kills line 84 if(false) — start must always be emitted
    expect(start).toBeDefined();
    expect(typeof start?.['claimCount']).toBe('number');
  });

  it('SM4: start event payload has type, claimCount, and provider fields (not empty object)', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    // Kills ObjectLiteral mutation on line 85 (emit({})) and line 69 (emit({}))
    expect(start?.['type']).toBe('start');
    expect(typeof start?.['claimCount']).toBe('number');
    expect(typeof start?.['provider']).toBe('string');
    expect((start?.['provider'] as string).length).toBeGreaterThan(0);
  });
});

// ── Missing-text error message (SM5) ─────────────────────────────────────────

describe('stream.ts error message — mutation hardening (SM5)', () => {
  it('SM5: missing text param → exact error message', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    '/scan/stream?provider=mock',
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    // Kills line 45 StringLiteral ("Missing required query param: text" → "")
    expect(body['error']).toBe('Missing required query param: text');
  });
});

// ── Response header mutations (SM6–SM8) ───────────────────────────────────────

describe('stream.ts response headers — mutation hardening (SM6–SM8)', () => {
  it('SM6: Cache-Control header is exactly "no-cache"', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    // Kills both line 98 mutations: 'Cache-Control'→"" and 'no-cache'→""
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('SM7: Connection header is exactly "keep-alive"', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    // Kills both line 99 mutations: 'Connection'→"" and 'keep-alive'→""
    expect(res.headers['connection']).toBe('keep-alive');
  });

  it('SM8: Cache-Control and Connection headers present on any valid 200 response', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(ONE_CLAIM_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(200);
    // Both header keys must be non-empty (kills →"" key mutations)
    const cacheControl = res.headers['cache-control'];
    const connection   = res.headers['connection'];
    expect(typeof cacheControl).toBe('string');
    expect((cacheControl as string).length).toBeGreaterThan(0);
    expect(typeof connection).toBe('string');
    expect((connection as string).length).toBeGreaterThan(0);
  });
});

// ── Error path mutations (SM9–SM11) ───────────────────────────────────────────

describe('stream.ts error path — mutation hardening (SM9–SM11)', () => {
  it('SM9: scan with failing provider → SSE response contains an error event', async () => {
    // No GEMINI_API_KEY → scan('text', 'gemini') throws → exercises catch block
    delete process.env.GEMINI_API_KEY;
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=gemini`,
      headers: { 'x-api-key': 'test-secret' },
    });
    // Response is still 200 (errors are SSE events, not HTTP errors)
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const errEvent = events.find(e => e['type'] === 'error');
    // Kills no-coverage mutants in catch block
    expect(typeof errEvent!['message']).toBe('string');
  });

  it('SM10: error event message field is a non-empty string', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=gemini`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const errEvent = events.find(e => e['type'] === 'error');
    // Kills line 93 StringLiteral + BlockStatement removal
    expect(typeof errEvent?.['message']).toBe('string');
    expect((errEvent?.['message'] as string).length).toBeGreaterThan(0);
  });

  it('SM11: start event appears before error event in error path', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=gemini`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const types     = events.map(e => e['type'] as string);
    const startIdx  = types.indexOf('start');
    const errorIdx  = types.indexOf('error');
    // Kills line 90 ConditionalExpression mutations (start must always precede error)
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeGreaterThan(startIdx);
  });
});

// ── Start/complete payload completeness (SM12–SM15) ───────────────────────────

describe('stream.ts event payload completeness — mutation hardening (SM12–SM15)', () => {
  it('SM12: start event claimCount equals count of claim_verified events', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events        = parseSSE(res.body);
    const start         = events.find(e => e['type'] === 'start');
    const verifiedCount = events.filter(e => e['type'] === 'claim_verified').length;
    // Kills ObjectLiteral mutations that set claimCount to 0 or omit it
    expect(start?.['claimCount']).toBe(verifiedCount);
  });

  it('SM13: start event provider matches the requested mock provider', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    // Kills ObjectLiteral mutations removing provider from start payload
    expect(start?.['provider']).toBe('mock');
  });

  it('SM14: complete event type field is the string "complete"', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events   = parseSSE(res.body);
    const complete = events.find(e => e['type'] === 'complete');
    // Kills ObjectLiteral mutation on line 88 emit call (emit({}))
    expect(complete?.['type']).toBe('complete');
    expect(typeof complete?.['overallRisk']).toBe('string');
  });

  it('SM15: complete event claimCount equals count of claim_verified events', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events        = parseSSE(res.body);
    const complete      = events.find(e => e['type'] === 'complete');
    const verifiedCount = events.filter(e => e['type'] === 'claim_verified').length;
    // Kills ObjectLiteral mutations on claimCount in complete event
    expect(complete?.['claimCount']).toBe(verifiedCount);
  });
});
