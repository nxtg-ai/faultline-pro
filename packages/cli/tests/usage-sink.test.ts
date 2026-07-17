/**
 * usage-sink.test.ts — BLG-005 defect-1 seam: per-scan usage collector.
 *
 * The load-bearing test is US-03: two OVERLAPPING capture scopes with
 * interleaved awaits must each collect ONLY their own legs. A module-global
 * collector passes every other test here and FAILS US-03 — that is precisely
 * the concurrent-Fastify cross-attribution bug the ALS design exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { captureUsage, recordUsage, isCapturing, type UsageLeg } from '../lib/usage-sink.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const leg = (provider: string, inputTokens: number): UsageLeg => ({
  provider, callType: `grounded-verify:${provider}`, inputTokens, outputTokens: 0, isGrounding: false,
});

describe('usage-sink', () => {
  it('US-01: recordUsage outside a scope is a no-op and does not throw', () => {
    expect(isCapturing()).toBe(false);
    expect(() => recordUsage(leg('openai', 10))).not.toThrow();
  });

  it('US-02: a single scope collects exactly its own legs', async () => {
    const { result, legs } = await captureUsage(async () => {
      expect(isCapturing()).toBe(true);
      recordUsage(leg('openai', 1));
      recordUsage(leg('gemini', 2));
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(legs).toHaveLength(2);
    expect(legs.map((l) => l.inputTokens)).toEqual([1, 2]);
    // scope closed → capture inactive again
    expect(isCapturing()).toBe(false);
  });

  it('US-03: CONCURRENCY — two overlapping scopes never cross-attribute usage', async () => {
    const scope = (tag: string, tokens: number[]) =>
      captureUsage(async () => {
        recordUsage(leg(tag, tokens[0]));
        await tick();                       // yield — the other scope runs here
        recordUsage(leg(tag, tokens[1]));
        await tick();
        recordUsage(leg(tag, tokens[2]));
        return tag;
      });

    const [a, b] = await Promise.all([
      scope('openai', [11, 12, 13]),
      scope('gemini', [21, 22, 23]),
    ]);

    // each scope sees ONLY its own three legs, in order — no interleave bleed
    expect(a.legs.map((l) => l.inputTokens)).toEqual([11, 12, 13]);
    expect(b.legs.map((l) => l.inputTokens)).toEqual([21, 22, 23]);
    expect(a.legs.every((l) => l.provider === 'openai')).toBe(true);
    expect(b.legs.every((l) => l.provider === 'gemini')).toBe(true);
  });

  it('US-04: sequential scopes do not leak legs into each other', async () => {
    const first = await captureUsage(async () => { recordUsage(leg('openai', 1)); return 1; });
    const second = await captureUsage(async () => { recordUsage(leg('gemini', 2)); return 2; });
    expect(first.legs).toHaveLength(1);
    expect(second.legs).toHaveLength(1);
    expect(second.legs[0].provider).toBe('gemini');
  });
});
