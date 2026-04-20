/**
 * N-134 — GET /scan/stream SSE endpoint (WS1–WS15)
 *
 * Verifies the Server-Sent Events scan streaming endpoint:
 *   WS1:  200 with Content-Type text/event-stream
 *   WS2:  Response body contains a 'start' event
 *   WS3:  start event has claimCount field
 *   WS4:  start event has provider field matching requested provider
 *   WS5:  Response body contains at least one 'claim_verified' event
 *   WS6:  claim_verified event has a 'claim' field
 *   WS7:  claim_verified event has a 'verdict' field
 *   WS8:  claim_verified event has an 'index' field
 *   WS9:  Response body contains a 'complete' event
 *   WS10: complete event has 'overallRisk' field
 *   WS11: complete event claimCount matches start event claimCount
 *   WS12: Event order: start appears before claim_verified, which appears before complete
 *   WS13: Missing text param → 400
 *   WS14: No x-api-key header → 401
 *   WS15: Explicit 'mock' provider is reflected in start event
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

const SCAN_TEXT = 'The Eiffel Tower is located in Berlin. Water boils at 150 degrees Celsius.';

/** Parse raw SSE body into an array of typed event objects */
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
});

// ── WS1: 200 with text/event-stream ──────────────────────────────────────────

describe('GET /scan/stream — response status and content-type (WS1)', () => {
  it('WS1: returns 200 with Content-Type text/event-stream', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });
});

// ── WS2–WS4: start event ─────────────────────────────────────────────────────

describe('GET /scan/stream — start event (WS2–WS4)', () => {
  it('WS2: response body contains a start event', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    expect(start!['type']).toBe('start');
  });

  it('WS3: start event has claimCount field (non-negative integer)', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    expect(typeof start?.['claimCount']).toBe('number');
    expect(start?.['claimCount'] as number).toBeGreaterThanOrEqual(0);
  });

  it('WS4: start event provider field matches the requested provider', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    expect(start?.['provider']).toBe('mock');
  });
});

// ── WS5–WS8: claim_verified events ───────────────────────────────────────────

describe('GET /scan/stream — claim_verified events (WS5–WS8)', () => {
  it('WS5: response body contains at least one claim_verified event', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const verified = events.filter(e => e['type'] === 'claim_verified');
    expect(verified.length).toBeGreaterThan(0);
  });

  it('WS6: each claim_verified event has a claim field', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const verified = events.filter(e => e['type'] === 'claim_verified');
    for (const ev of verified) {
      expect(typeof (ev['claim'] as { id: string }).id).toBe('string');
    }
  });

  it('WS7: each claim_verified event has a verdict field (object or null)', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const verified = events.filter(e => e['type'] === 'claim_verified');
    for (const ev of verified) {
      expect('verdict' in ev).toBe(true);
    }
  });

  it('WS8: each claim_verified event has a numeric index field', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const verified = events.filter(e => e['type'] === 'claim_verified');
    for (const ev of verified) {
      expect(typeof ev['index']).toBe('number');
    }
  });
});

// ── WS9–WS11: complete event ──────────────────────────────────────────────────

describe('GET /scan/stream — complete event (WS9–WS11)', () => {
  it('WS9: response body contains a complete event', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const complete = events.find(e => e['type'] === 'complete');
    expect(complete!['type']).toBe('complete');
  });

  it('WS10: complete event has overallRisk field (non-empty string)', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const complete = events.find(e => e['type'] === 'complete');
    expect(typeof complete?.['overallRisk']).toBe('string');
    expect((complete?.['overallRisk'] as string).length).toBeGreaterThan(0);
  });

  it('WS11: complete event claimCount matches start event claimCount', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const start    = events.find(e => e['type'] === 'start');
    const complete = events.find(e => e['type'] === 'complete');
    expect(complete?.['claimCount']).toBe(start?.['claimCount']);
  });
});

// ── WS12: event ordering ──────────────────────────────────────────────────────

describe('GET /scan/stream — event ordering (WS12)', () => {
  it('WS12: events arrive in order: start → claim_verified × N → complete', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events = parseSSE(res.body);
    const types = events.map(e => e['type'] as string);

    const startIdx    = types.indexOf('start');
    const firstVerify = types.indexOf('claim_verified');
    const completeIdx = types.indexOf('complete');

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(firstVerify).toBeGreaterThan(startIdx);
    expect(completeIdx).toBeGreaterThan(firstVerify);
  });
});

// ── WS13: missing text param ──────────────────────────────────────────────────

describe('GET /scan/stream — validation (WS13)', () => {
  it('WS13: missing text query param returns 400', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    '/scan/stream?provider=mock',
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
  });
});

// ── WS14: auth enforcement ────────────────────────────────────────────────────

describe('GET /scan/stream — auth enforcement (WS14)', () => {
  it('WS14: request without x-api-key header returns 401', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── WS15: explicit provider reflected in start event ─────────────────────────

describe('GET /scan/stream — provider reflection (WS15)', () => {
  it('WS15: explicit mock provider is reflected in start event', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(200);
    const events = parseSSE(res.body);
    const start = events.find(e => e['type'] === 'start');
    // Explicit mock provider is echoed back in the start event provider field
    expect(start?.['provider']).toBe('mock');
  });
});
