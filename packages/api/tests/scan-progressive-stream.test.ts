/**
 * N-135 — Progressive per-claim SSE streaming via onClaimVerified callback (PS1–PS15)
 *
 * scan() onClaimVerified callback API (PS1–PS9):
 *   PS1:  scan() accepts onClaimVerified without throwing
 *   PS2:  callback fires exactly once per verifiable claim
 *   PS3:  callback receives claim with id and text fields
 *   PS4:  callback receives verdict with status field
 *   PS5:  callback receives zero-based index (first call = 0)
 *   PS6:  callback indices are strictly ascending
 *   PS7:  callback total param matches number of verifiable claims
 *   PS8:  omitting onClaimVerified does not change scan result shape
 *   PS9:  scan() with callback produces same overallRisk as without
 *
 * GET /scan/stream progressive delivery (PS10–PS15):
 *   PS10: claim_verified event indices form a 0-based contiguous sequence
 *   PS11: each claim_verified claim has an id field
 *   PS12: each claim_verified event includes a verdict key
 *   PS13: count of claim_verified events equals claimCount from start event
 *   PS14: count of claim_verified events equals claimCount from complete event
 *   PS15: claim_verified indices are unique (no duplicate delivery)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scan, type ScanClaimCallback } from '@nxtg/faultline/cli/scan.js';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

const SCAN_TEXT = 'The Eiffel Tower is located in Berlin. Water boils at 150 degrees Celsius.';

/** Parse raw SSE body into typed event objects */
function parseSSE(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter(chunk => chunk.startsWith('data: '))
    .map(chunk => JSON.parse(chunk.replace(/^data: /, '')) as Record<string, unknown>);
}

// ── PS1–PS9: scan() onClaimVerified callback unit tests ──────────────────────

describe('scan() onClaimVerified callback (PS1–PS7)', () => {
  it('PS1: scan() accepts onClaimVerified callback without throwing', async () => {
    const cb: ScanClaimCallback = () => { /* no-op */ };
    await expect(scan(SCAN_TEXT, 'mock', undefined, undefined, undefined, cb)).resolves.toBeDefined();
  });

  it('PS2: callback fires exactly once per verifiable claim', async () => {
    const fired: number[] = [];
    await scan(SCAN_TEXT, 'mock', undefined, undefined, undefined,
      (_claim, _verdict, index) => { fired.push(index); });

    const result = await scan(SCAN_TEXT, 'mock');
    // Count verifiable claims from the result (same as filterClaimsForVerification produces)
    const verifiableCount = Object.keys(result.verifications).length;
    expect(fired.length).toBe(verifiableCount);
  });

  it('PS3: callback receives claim with id and text fields', async () => {
    const claims: Claim[] = [];
    await scan(SCAN_TEXT, 'mock', undefined, undefined, undefined,
      (claim) => { claims.push(claim); });

    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.text).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
    }
  });

  it('PS4: callback receives verdict with status field', async () => {
    const verdicts: VerificationResult[] = [];
    await scan(SCAN_TEXT, 'mock', undefined, undefined, undefined,
      (_claim, verdict) => { verdicts.push(verdict); });

    expect(verdicts.length).toBeGreaterThan(0);
    for (const v of verdicts) {
      expect(typeof v.status).toBe('string');
    }
  });

  it('PS5: first callback invocation receives index 0', async () => {
    const indices: number[] = [];
    await scan(SCAN_TEXT, 'mock', undefined, undefined, undefined,
      (_claim, _verdict, index) => { indices.push(index); });

    expect(indices[0]).toBe(0);
  });

  it('PS6: callback indices are strictly ascending (0, 1, 2, ...)', async () => {
    const indices: number[] = [];
    await scan(SCAN_TEXT, 'mock', undefined, undefined, undefined,
      (_claim, _verdict, index) => { indices.push(index); });

    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1] + 1);
    }
  });

  it('PS7: total param in every callback call equals number of verifiable claims', async () => {
    const totals: number[] = [];
    await scan(SCAN_TEXT, 'mock', undefined, undefined, undefined,
      (_claim, _verdict, _index, total) => { totals.push(total); });

    // All total values must be equal (same count throughout)
    expect(totals.length).toBeGreaterThan(0);
    expect(new Set(totals).size).toBe(1);
    // And must equal the actual verifiable claim count
    const result = await scan(SCAN_TEXT, 'mock');
    expect(totals[0]).toBe(Object.keys(result.verifications).length);
  });
});

describe('scan() with and without onClaimVerified — backward compat (PS8–PS9)', () => {
  it('PS8: result shape is identical with and without onClaimVerified', async () => {
    const withCb    = await scan(SCAN_TEXT, 'mock', undefined, undefined, undefined, () => { /* no-op */ });
    const withoutCb = await scan(SCAN_TEXT, 'mock');

    expect(Object.keys(withCb)).toEqual(Object.keys(withoutCb));
    expect(withCb.overallRisk).toBe(withoutCb.overallRisk);
    expect(withCb.claims.length).toBe(withoutCb.claims.length);
  });

  it('PS9: overallRisk is the same with and without onClaimVerified', async () => {
    const withCb    = await scan(SCAN_TEXT, 'mock', undefined, undefined, undefined, () => { /* no-op */ });
    const withoutCb = await scan(SCAN_TEXT, 'mock');
    expect(withCb.overallRisk).toBe(withoutCb.overallRisk);
  });
});

// ── PS10–PS15: GET /scan/stream progressive delivery tests ───────────────────

describe('GET /scan/stream — progressive delivery (PS10–PS15)', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-secret';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('PS10: claim_verified indices form a 0-based contiguous sequence', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events   = parseSSE(res.body);
    const verified = events.filter(e => e['type'] === 'claim_verified');
    const indices  = verified.map(e => e['index'] as number);

    expect(indices.length).toBeGreaterThan(0);
    for (let i = 0; i < indices.length; i++) {
      expect(indices[i]).toBe(i);
    }
  });

  it('PS11: each claim_verified event has a claim with an id field', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events   = parseSSE(res.body);
    const verified = events.filter(e => e['type'] === 'claim_verified');

    expect(verified.length).toBeGreaterThan(0);
    for (const ev of verified) {
      const claim = ev['claim'] as Record<string, unknown>;
      expect(typeof claim['id']).toBe('string');
    }
  });

  it('PS12: each claim_verified event contains a verdict key', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events   = parseSSE(res.body);
    const verified = events.filter(e => e['type'] === 'claim_verified');

    expect(verified.length).toBeGreaterThan(0);
    for (const ev of verified) {
      expect('verdict' in ev).toBe(true);
    }
  });

  it('PS13: count of claim_verified events equals claimCount from start event', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events       = parseSSE(res.body);
    const start        = events.find(e => e['type'] === 'start');
    const verifiedCount = events.filter(e => e['type'] === 'claim_verified').length;

    expect(start?.['claimCount']).toBe(verifiedCount);
  });

  it('PS14: count of claim_verified events equals claimCount from complete event', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events        = parseSSE(res.body);
    const complete      = events.find(e => e['type'] === 'complete');
    const verifiedCount = events.filter(e => e['type'] === 'claim_verified').length;

    expect(complete?.['claimCount']).toBe(verifiedCount);
  });

  it('PS15: claim_verified indices are unique — no duplicate delivery', async () => {
    const res = await server.inject({
      method: 'GET',
      url:    `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=mock`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const events   = parseSSE(res.body);
    const indices  = events
      .filter(e => e['type'] === 'claim_verified')
      .map(e => e['index'] as number);

    expect(indices.length).toBeGreaterThan(0);
    expect(new Set(indices).size).toBe(indices.length);
  });
});
