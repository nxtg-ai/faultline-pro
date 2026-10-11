/**
 * ARU-01 workstream D (DIRECTIVE-NXTG-20261011-FAULTLINE-ARU-01): /costs/percentiles must
 * survive a deploy and report latency, so cost per scan can be read per tier from
 * production instead of off the Fly volume by hand.
 *
 * Validates: N-227 (scan_cost telemetry) — hydration from scan-cost.jsonl, latency, tier filter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { getCostStore, loadScanCostLog, resetCostStore } from '../src/store/costs.js';

/** A row exactly as appendScanCostLog writes it. */
function row(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: new Date().toISOString(), scan_id: 's1', user_tier: 'personal', key_mode: 'managed',
    provider: 'gemini', model_id: 'gemini-2.5-flash', input_tokens: 900, output_tokens: 4000,
    tool_call_count: 8, wall_ms: 21000, usd_estimate: 0.2843, cache_hit: false, ...over,
  });
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scan-cost-')); resetCostStore(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetCostStore(); });

describe('loadScanCostLog()', () => {
  it('SCH-01: maps every written field back onto the event', () => {
    const p = join(dir, 'log.jsonl');
    writeFileSync(p, row() + '\n');
    const ev = loadScanCostLog(p);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      scanId: 's1', tier: 'personal', keyMode: 'managed', provider: 'gemini', modelId: 'gemini-2.5-flash',
      inputTokens: 900, outputTokens: 4000, groundingCalls: 8, costUsd: 0.2843, latencyMs: 21000, cacheHit: false,
    });
  });

  it('SCH-02: skips malformed JSON, unknown tiers and rows without ts', () => {
    const p = join(dir, 'log.jsonl');
    writeFileSync(p, [row(), '{not json', row({ user_tier: 'galaxy' }), row({ ts: 5 }), '', row({ scan_id: 's2' })].join('\n'));
    const ev = loadScanCostLog(p);
    expect(ev.map((e) => e.scanId)).toEqual(['s1', 's2']);
  });

  it('SCH-03: a missing file gives []', () => {
    expect(loadScanCostLog(join(dir, 'absent.jsonl'))).toEqual([]);
  });
});

describe('getCostStore() hydration', () => {
  it('SCH-04: outside tests the store starts with the logged scans (survives a deploy)', () => {
    const p = join(dir, 'log.jsonl');
    writeFileSync(p, [row({ scan_id: 'a' }), row({ scan_id: 'b', usd_estimate: 0.0123 })].join('\n') + '\n');
    const saved = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV, LOG: process.env.FAULTLINE_SCAN_COST_LOG };
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      process.env.FAULTLINE_SCAN_COST_LOG = p;
      resetCostStore();
      expect(getCostStore().getPercentiles(30).count).toBe(2);
    } finally {
      process.env.VITEST = saved.VITEST;
      if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.LOG === undefined) delete process.env.FAULTLINE_SCAN_COST_LOG; else process.env.FAULTLINE_SCAN_COST_LOG = saved.LOG;
      resetCostStore();
    }
  });

  it('SCH-05: under tests the production log is never read', () => {
    const p = join(dir, 'log.jsonl');
    writeFileSync(p, row() + '\n');
    process.env.FAULTLINE_SCAN_COST_LOG = p;
    try {
      resetCostStore();
      expect(getCostStore().getPercentiles(30).count).toBe(0);
    } finally {
      delete process.env.FAULTLINE_SCAN_COST_LOG;
    }
  });
});

describe('getPercentiles() latency and tier', () => {
  it('SCH-06: reports wall latency percentiles and filters to one tier', () => {
    const p = join(dir, 'log.jsonl');
    writeFileSync(p, [
      row({ scan_id: 'p1', wall_ms: 10000, usd_estimate: 0.10 }),
      row({ scan_id: 'p2', wall_ms: 30000, usd_estimate: 0.30 }),
      row({ scan_id: 'e1', user_tier: 'enterprise', wall_ms: 60000, usd_estimate: 0.88 }),
    ].join('\n'));
    getCostStore().hydrate(loadScanCostLog(p));
    const all = getCostStore().getPercentiles(30);
    expect(all.count).toBe(3);
    expect(all.latencyMs.p99).toBe(60000);
    const personal = getCostStore().getPercentiles(30, 'personal');
    expect(personal.count).toBe(2);
    expect(personal.tier).toBe('personal');
    expect(personal.p50).toBeCloseTo(0.10, 6);
    expect(personal.p99).toBeCloseTo(0.30, 6);
    expect(personal.latencyMs).toEqual({ p50: 10000, p90: 30000, p99: 30000 });
  });
});

describe('GET /costs/percentiles', () => {
  async function app() {
    const { costsRoutes } = await import('../src/routes/costs.js');
    const { getKeyStore } = await import('../src/store/keys.js');
    const f = Fastify();
    await f.register(costsRoutes);
    const key = getKeyStore().create('pct-test');
    return { f, key: key.key };
  }

  it('SCH-07: tier=personal returns only personal scans with latency; a bad tier is 400', async () => {
    getCostStore().hydrate([
      { scanId: 'x', ts: new Date().toISOString(), tier: 'personal', keyMode: 'managed', provider: 'gemini',
        inputTokens: 1, outputTokens: 1, groundingCalls: 8, costUsd: 0.28, latencyMs: 20000 },
      { scanId: 'y', ts: new Date().toISOString(), tier: 'enterprise', keyMode: 'managed', provider: 'gemini',
        inputTokens: 1, outputTokens: 1, groundingCalls: 25, costUsd: 0.88, latencyMs: 50000 },
    ]);
    const { f, key } = await app();
    const ok = await f.inject({ method: 'GET', url: '/costs/percentiles?tier=personal', headers: { 'x-api-key': key } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ count: 1, tier: 'personal', p50: 0.28, latencyMs: { p50: 20000 } });
    const bad = await f.inject({ method: 'GET', url: '/costs/percentiles?tier=galaxy', headers: { 'x-api-key': key } });
    expect(bad.statusCode).toBe(400);
    await f.close();
  });
});
