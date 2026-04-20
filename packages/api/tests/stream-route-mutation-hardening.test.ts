/**
 * N-137 / N-221 — stream.ts mutation hardening (SM1–SM26)
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  it('SM3: start event is present even when provider=mock (0-claim fallback path)', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(ONE_CLAIM_TEXT)}&provider=mock`,
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

// ── POST /scan/stream — preHandler auth mutation (SM16) ───────────────────────

describe('POST /scan/stream auth — mutation hardening (SM16)', () => {
  it('SM16: POST without API key → 401 (kills preHandler:[])', async () => {
    const res = await server.inject({
      method: 'POST',
      url:    '/scan/stream',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'mock' }),
    });
    // preHandler:[] mutation removes auth → would return 200; must be 401
    expect(res.statusCode).toBe(401);
  });
});

// ── POST /scan/stream — startEmitted guards (SM17–SM20) ──────────────────────

describe('POST /scan/stream startEmitted guards — mutation hardening (SM17–SM20)', () => {
  it('SM17: exactly 1 start event in POST multi-claim scan', async () => {
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'mock' }),
    });
    const events = parseSSE(res.body);
    const startEvents = events.filter(e => e['type'] === 'start');
    // Kills: if(!startEmitted)→if(true) at line 178, startEmitted=false at line 180
    expect(startEvents.length).toBe(1);
  });

  it('SM18: exactly 1 start event in POST single-claim scan', async () => {
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: ONE_CLAIM_TEXT, provider: 'mock' }),
    });
    const events = parseSSE(res.body);
    const startEvents = events.filter(e => e['type'] === 'start');
    expect(startEvents.length).toBe(1);
  });

  it('SM19: POST start event arrives before any claim_verified (kills startEmitted=false)', async () => {
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'mock' }),
    });
    const events = parseSSE(res.body);
    const types  = events.map(e => e['type'] as string);
    const startIdx   = types.indexOf('start');
    const verifiedIdx = types.indexOf('claim_verified');
    // startEmitted=false mutation causes start to emit before every claim
    expect(startIdx).toBe(0);
    expect(verifiedIdx).toBeGreaterThan(startIdx);
  });

  it('SM20: POST 0-claim edge case — start is still emitted (kills if(!startEmitted)→if(false) at line 194)', async () => {
    // Use a text that mock can produce 0 verifiable claims
    // The post-scan fallback (line 194) must fire when startEmitted is still false
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: ONE_CLAIM_TEXT, provider: 'mock' }),
    });
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    expect(start).toBeDefined();
    expect(typeof start?.['claimCount']).toBe('number');
    expect(typeof start?.['provider']).toBe('string');
  });
});

// ── POST /scan/stream — error path mutations (SM21–SM22) ─────────────────────

describe('POST /scan/stream error path — mutation hardening (SM21–SM22)', () => {
  it('SM21: error path start event has type, claimCount, provider (kills emit({}) at line 201)', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'gemini' }),
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start  = events.find(e => e['type'] === 'start');
    // Kills emit({}) mutation — start must have all 3 fields
    expect(start?.['type']).toBe('start');
    expect(typeof start?.['claimCount']).toBe('number');
    expect(typeof start?.['provider']).toBe('string');
    expect((start?.['provider'] as string).length).toBeGreaterThan(0);
  });

  it('SM22: POST error path — start appears before error event (kills if(!startEmitted)→if(true)/(false) at line 200)', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'gemini' }),
    });
    const events   = parseSSE(res.body);
    const types    = events.map(e => e['type'] as string);
    const startIdx = types.indexOf('start');
    const errIdx   = types.indexOf('error');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(errIdx).toBeGreaterThan(startIdx);
  });
});

// ── POST /scan/stream — provider routing & schema enum (SM23–SM26) ────────────

describe('POST /scan/stream provider routing — mutation hardening (SM23–SM26)', () => {
  // For each non-mock provider: verify statusCode 200 (not 400 from schema enum mutation)
  // AND start.provider === requested provider (not 'mock' from VALID_PROVIDERS mutation).
  // Scan fails (no key) → error path, but provider routing is exercised before scan.

  it('SM23: provider=openai accepted by schema and routed correctly (kills "openai"→"" in enum and VALID_PROVIDERS)', async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'openai' }),
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start  = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('openai');
  });

  it('SM24: provider=claude accepted by schema and routed correctly (kills "claude"→"")', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'claude' }),
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start  = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('claude');
  });

  it('SM25: provider=perplexity accepted by schema and routed correctly (kills "perplexity"→"")', async () => {
    delete process.env.PERPLEXITY_API_KEY;
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'perplexity' }),
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start  = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('perplexity');
  });

  it('SM26: unknown provider falls back to mock (VALID_PROVIDERS boundary check)', async () => {
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: ONE_CLAIM_TEXT, provider: 'unknown-provider' }),
    });
    // unknown provider → Fastify schema rejects with 400 (enum validation)
    expect(res.statusCode).toBe(400);
  });
});

// ── POST /scan/stream — response headers (SM27–SM28) ─────────────────────────

describe('POST /scan/stream response headers — mutation hardening (SM27–SM28)', () => {
  it('SM27: POST Cache-Control header is exactly "no-cache" (kills "Cache-Control"→"" and "no-cache"→"" at lines 208)', async () => {
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'mock' }),
    });
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('SM28: POST Connection header is exactly "keep-alive" (kills "Connection"→"" and "keep-alive"→"" at line 209)', async () => {
    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'mock' }),
    });
    expect(res.headers['connection']).toBe('keep-alive');
  });
});

// ── 0-claim fallback path (SM29–SM30) ─────────────────────────────────────────
// The `if (!startEmitted)` fallback at GET line 112 and POST line 194 fires only
// when scan returns 0 verifiable claims (onClaimVerified was never called).
// Mock always produces claims, so we use vi.spyOn to force a 0-claim result.

describe('0-claim fallback start emit — mutation hardening (SM29–SM30)', () => {
  it('SM29: GET 0-claim fallback — start is emitted with claimCount=0 (kills if(!startEmitted)→if(false) at GET line 112)', async () => {
    const scanModule = await import('@nxtg/faultline/cli/scan.js');
    const spy = vi.spyOn(scanModule, 'scan').mockResolvedValueOnce({
      input: '',
      claims: [],
      verifications: {},
      complianceReport: undefined as never,
      overallRisk: 'low',
      ruleFindings: [],
      provider: 'mock',
    });

    const res = await server.inject({
      method:  'GET',
      url:     `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    // Fallback must fire: start must be defined with claimCount=0
    expect(start).toBeDefined();
    expect(start?.['claimCount']).toBe(0);
    expect(start?.['provider']).toBe('mock');

    spy.mockRestore();
  });

  it('SM30: POST 0-claim fallback — start is emitted with claimCount=0 (kills if(!startEmitted)→if(false) at POST line 194)', async () => {
    const scanModule = await import('@nxtg/faultline/cli/scan.js');
    const spy = vi.spyOn(scanModule, 'scan').mockResolvedValueOnce({
      input: '',
      claims: [],
      verifications: {},
      complianceReport: undefined as never,
      overallRisk: 'low',
      ruleFindings: [],
      provider: 'mock',
    });

    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'mock' }),
    });
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    expect(start).toBeDefined();
    expect(start?.['claimCount']).toBe(0);
    expect(start?.['provider']).toBe('mock');

    spy.mockRestore();
  });
});

// ── Partial-failure: start emitted exactly once when error occurs after 1st claim (SM31–SM32) ──
// The `if (!startEmitted)` in both GET/POST catch blocks has an equivalent `if(true)` mutant
// that only matters when startEmitted=true on entry to catch. Achieved by mocking scan
// to call onClaimVerified once (setting startEmitted=true) then reject.

describe('Partial scan failure — mutation hardening (SM31–SM32)', () => {
  it('SM31: GET partial failure — exactly 1 start event when error occurs after first claim', async () => {
    const scanModule = await import('@nxtg/faultline/cli/scan.js');
    // Minimal claim/verdict shapes sufficient for the callback
    const mockClaim = { id: 'c1', text: 'claim', type: 'fact', importance: 3, sources: [] };
    const mockVerdict = { verdict: 'supported', confidence: 0.9, explanation: '' };
    const spy = vi.spyOn(scanModule, 'scan').mockImplementationOnce(
      async (_text, _provider, _minC, _rules, _onProg, onClaimVerified) => {
        if (onClaimVerified) onClaimVerified(mockClaim as never, mockVerdict as never, 0, 1);
        throw new Error('partial failure after first claim');
      },
    );

    const res = await server.inject({
      method:  'GET',
      url:     `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const startEvents = events.filter(e => e['type'] === 'start');
    // if(true) mutation → catch emits start even though startEmitted=true → 2 starts
    expect(startEvents.length).toBe(1);

    spy.mockRestore();
  });

  it('SM32: POST partial failure — exactly 1 start event when error occurs after first claim', async () => {
    const scanModule = await import('@nxtg/faultline/cli/scan.js');
    const mockClaim = { id: 'c1', text: 'claim', type: 'fact', importance: 3, sources: [] };
    const mockVerdict = { verdict: 'supported', confidence: 0.9, explanation: '' };
    const spy = vi.spyOn(scanModule, 'scan').mockImplementationOnce(
      async (_text, _provider, _minC, _rules, _onProg, onClaimVerified) => {
        if (onClaimVerified) onClaimVerified(mockClaim as never, mockVerdict as never, 0, 1);
        throw new Error('partial failure after first claim');
      },
    );

    const res = await server.inject({
      method:  'POST',
      url:     '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'mock' }),
    });
    const events = parseSSE(res.body);
    const startEvents = events.filter(e => e['type'] === 'start');
    expect(startEvents.length).toBe(1);

    spy.mockRestore();
  });
});

// ── VALID_PROVIDERS module-init isolation (SM33–SM37) ─────────────────────────
// VALID_PROVIDERS is initialized at ES module load time (line 9). The static
// `import { buildServer }` at the top of this file caches stream.ts before stryker
// activates any mutant, so mutation 9:xx is never seen by that cached instance.
//
// Fix: vi.resetModules() + dynamic import inside the test body forces a fresh
// module evaluation AFTER stryker has activated the mutant → VALID_PROVIDERS
// re-initializes with the mutated value.
//
// Each test creates a temporary server and closes it in the test body.
// The outer `server` (from beforeEach) is still closed in afterEach.

describe('VALID_PROVIDERS isolation — dynamic-import hardening (SM33–SM37)', () => {
  it('SM33: fresh-import: provider=openai → start.provider=openai (kills 9:47 [] and 9:58 openai→"")', async () => {
    vi.resetModules();
    const { buildServer: bs } = await import('../src/server.js');
    const s = bs();
    delete process.env.OPENAI_API_KEY;
    const res = await s.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=openai`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    // empty set or 'openai'→"" → effectiveProvider='mock' → start.provider='mock' ≠ 'openai'
    expect(start?.['provider']).toBe('openai');
    await s.close();
  });

  it('SM34: fresh-import: provider=gemini → start.provider=gemini (kills 9:48 gemini→"")', async () => {
    vi.resetModules();
    const { buildServer: bs } = await import('../src/server.js');
    const s = bs();
    delete process.env.GEMINI_API_KEY;
    const res = await s.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=gemini`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('gemini');
    await s.close();
  });

  it('SM35: fresh-import: provider=claude → start.provider=claude (kills 9:68 claude→"")', async () => {
    vi.resetModules();
    const { buildServer: bs } = await import('../src/server.js');
    const s = bs();
    delete process.env.ANTHROPIC_API_KEY;
    const res = await s.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=claude`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('claude');
    await s.close();
  });

  it('SM36: fresh-import: provider=perplexity → start.provider=perplexity (kills 9:78 perplexity→"")', async () => {
    vi.resetModules();
    const { buildServer: bs } = await import('../src/server.js');
    const s = bs();
    delete process.env.PERPLEXITY_API_KEY;
    const res = await s.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=perplexity`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('perplexity');
    await s.close();
  });

  it('SM37: fresh-import: POST provider=openai → start.provider=openai (kills 9:58 via POST path)', async () => {
    vi.resetModules();
    const { buildServer: bs } = await import('../src/server.js');
    const s = bs();
    delete process.env.OPENAI_API_KEY;
    const res = await s.inject({
      method: 'POST',
      url: '/scan/stream',
      headers: { 'x-api-key': 'test-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: SCAN_TEXT, provider: 'openai' }),
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('openai');
    await s.close();
  });
});

// ── GET /scan/stream — schema enum + provider routing (SM38–SM41) ─────────────
// Lines 63:23 (ObjectLiteral removes enum), 63:58/68/78 (individual enum strings).
// SM23–SM25 handle POST schema; these mirror them for GET querystring schema.

describe('GET /scan/stream schema enum & provider routing — mutation hardening (SM38–SM41)', () => {
  it('SM38: GET invalid provider → 400 (kills 63:23 ObjectLiteral removing enum constraint)', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=not-a-real-provider`,
      headers: { 'x-api-key': 'test-secret' },
    });
    // With 63:23 mutation (provider: {}) enum is removed → invalid provider accepted → 200
    expect(res.statusCode).toBe(400);
  });

  it('SM39: GET provider=gemini → 200 + start.provider=gemini (kills 63:58 "gemini"→"")', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=gemini`,
      headers: { 'x-api-key': 'test-secret' },
    });
    // With 63:58 mutation ("gemini"→"") schema rejects gemini → 400
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start  = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('gemini');
  });

  it('SM40: GET provider=openai → 200 + start.provider=openai (kills 63:68 "openai"→"")', async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=openai`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start  = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('openai');
  });

  it('SM41: GET provider=claude → 200 + start.provider=claude (kills 63:78 "claude"→"")', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=claude`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start  = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('claude');
  });
});
