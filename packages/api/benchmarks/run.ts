/**
 * Faultline Pro — Benchmark Runner
 *
 * Measures scan latency per provider (or mock stand-in), cache hit ratio,
 * and concurrent scan throughput using Fastify's server.inject() (no TCP overhead).
 *
 * Usage:
 *   npx tsx packages/api/benchmarks/run.ts [--json]
 *
 * With real providers (API keys required):
 *   GEMINI_API_KEY=xxx OPENAI_API_KEY=xxx ANTHROPIC_API_KEY=xxx \
 *   PERPLEXITY_API_KEY=xxx npx tsx packages/api/benchmarks/run.ts
 *
 * Without API keys: all providers fall back to the mock scan path,
 * giving you framework-level latency (auth + cache + serialize) without LLM cost.
 */

import { buildServer } from '../src/server.js';
import { resetCache, getScanCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LatencyStats {
  n: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  meanMs: number;
}

interface ProviderResult {
  provider: string;
  isReal: boolean; // true = real API key was configured; false = mock fallback
  n: number;
  latency: LatencyStats;
  errorsCount: number;
}

interface CacheResult {
  warmupRequests: number;
  missN: number;
  hitN: number;
  missLatency: LatencyStats;
  hitLatency: LatencyStats;
  hitRatio: number;
  speedupFactor: number; // missP50 / hitP50
}

interface ConcurrencyResult {
  concurrency: number;
  totalRequests: number;
  wallTimeMs: number;
  throughputRps: number; // requests per second
  p50: number;
  p99: number;
  errorsCount: number;
}

export interface BenchmarkReport {
  generatedAt: string;
  environment: {
    nodeVersion: string;
    platform: string;
    cpus: number;
    memoryMb: number;
  };
  providers: ProviderResult[];
  cache: CacheResult;
  concurrency: ConcurrencyResult[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(latencies: number[]): LatencyStats {
  const s = [...latencies].sort((a, b) => a - b);
  const mean = s.reduce((acc, v) => acc + v, 0) / s.length;
  return {
    n: s.length,
    min: s[0] ?? 0,
    p50: pct(s, 50),
    p90: pct(s, 90),
    p95: pct(s, 95),
    p99: pct(s, 99),
    max: s[s.length - 1] ?? 0,
    meanMs: Math.round(mean * 100) / 100,
  };
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

async function injectScan(
  server: FastifyInstance,
  text: string,
  provider: string,
): Promise<{ statusCode: number; latencyMs: number; cacheHeader: string }> {
  const t0 = performance.now();
  const res = await server.inject({
    method: 'POST',
    url: '/scan',
    headers: { 'x-api-key': 'bench-key', 'content-type': 'application/json' },
    payload: JSON.stringify({ text, provider }),
  });
  const latencyMs = performance.now() - t0;
  return {
    statusCode: res.statusCode,
    latencyMs,
    cacheHeader: (res.headers['x-cache'] as string) ?? '',
  };
}

// ── Benchmark sections ────────────────────────────────────────────────────────

/**
 * Section 1: Provider scan latency
 *
 * For each provider, scan 50 unique texts (all cache MISSes) and collect latency.
 * With real API keys, this measures true E2E latency including LLM inference.
 * Without keys, it measures framework overhead (typically < 5ms).
 */
async function benchmarkProviders(server: FastifyInstance): Promise<ProviderResult[]> {
  const providers = [
    { name: 'gemini',     envKey: 'GEMINI_API_KEY' },
    { name: 'openai',     envKey: 'OPENAI_API_KEY' },
    { name: 'claude',     envKey: 'ANTHROPIC_API_KEY' },
    { name: 'perplexity', envKey: 'PERPLEXITY_API_KEY' },
    { name: 'mock',       envKey: '' },
  ];

  const results: ProviderResult[] = [];

  for (const { name, envKey } of providers) {
    const isReal = envKey ? !!process.env[envKey] : true; // mock is always "real"
    resetCache();

    const latencies: number[] = [];
    let errors = 0;

    // 50 unique texts — guaranteed cache misses
    const N = 50;
    for (let i = 0; i < N; i++) {
      const text = `Provider benchmark ${name} request ${i}: The Earth completes one orbit around the Sun in approximately 365.25 days.`;
      const { statusCode, latencyMs } = await injectScan(server, text, name);
      if (statusCode === 200) {
        latencies.push(latencyMs);
      } else {
        errors++;
      }
    }

    results.push({
      provider: name,
      isReal,
      n: N,
      latency: stats(latencies),
      errorsCount: errors,
    });

    log(`  ${name.padEnd(10)} p50=${fmt(pct([...latencies].sort((a, b) => a - b), 50))} p99=${fmt(pct([...latencies].sort((a, b) => a - b), 99))} errors=${errors}`);
  }

  return results;
}

/**
 * Section 2: Cache performance
 *
 * Measures hit vs miss latency and reports the hit ratio.
 */
async function benchmarkCache(server: FastifyInstance): Promise<CacheResult> {
  resetCache();
  const WARM_TEXT = 'The cache benchmark reference claim about the speed of light.';
  const N = 50;

  // Warm-up: populate cache with one entry
  await injectScan(server, WARM_TEXT, 'mock');

  // Measure MISS latencies (unique texts)
  const missLatencies: number[] = [];
  for (let i = 0; i < N; i++) {
    const { latencyMs } = await injectScan(server, `Cache miss text ${i} unique`, 'mock');
    missLatencies.push(latencyMs);
  }

  // Measure HIT latencies (same text, should always hit)
  const hitLatencies: number[] = [];
  for (let i = 0; i < N; i++) {
    const { latencyMs, cacheHeader } = await injectScan(server, WARM_TEXT, 'mock');
    hitLatencies.push(latencyMs);
    if (cacheHeader !== 'HIT') {
      // Unexpected miss — log but don't abort
      log(`  [warn] expected cache HIT but got '${cacheHeader}'`);
    }
  }

  const cacheStats = getScanCache().stats();
  const missStats = stats(missLatencies);
  const hitStats = stats(hitLatencies);

  const speedup = hitStats.p50 > 0
    ? Math.round((missStats.p50 / hitStats.p50) * 10) / 10
    : 1;

  log(`  MISS p50=${fmt(missStats.p50)} p99=${fmt(missStats.p99)}`);
  log(`  HIT  p50=${fmt(hitStats.p50)} p99=${fmt(hitStats.p99)}`);
  log(`  Hit ratio: ${(cacheStats.hitRate * 100).toFixed(1)}%  Speedup: ${speedup}×`);

  return {
    warmupRequests: 1,
    missN: N,
    hitN: N,
    missLatency: missStats,
    hitLatency: hitStats,
    hitRatio: cacheStats.hitRate,
    speedupFactor: speedup,
  };
}

/**
 * Section 3: Concurrent throughput
 *
 * Fires N requests in parallel and measures wall-clock time + RPS.
 * Concurrency levels: 5, 10, 25, 50.
 */
async function benchmarkConcurrency(server: FastifyInstance): Promise<ConcurrencyResult[]> {
  const levels = [5, 10, 25, 50];
  const results: ConcurrencyResult[] = [];

  for (const concurrency of levels) {
    resetCache();

    const t0 = performance.now();
    const outcomes = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        injectScan(
          server,
          `Concurrent benchmark text ${i}: Water boils at 100 degrees Celsius at sea level.`,
          'mock',
        ),
      ),
    );
    const wallTimeMs = performance.now() - t0;

    const latencies = outcomes.filter((o) => o.statusCode === 200).map((o) => o.latencyMs);
    const errors = outcomes.filter((o) => o.statusCode !== 200).length;
    const throughput = Math.round((concurrency / wallTimeMs) * 1000);
    const s = stats(latencies);

    results.push({
      concurrency,
      totalRequests: concurrency,
      wallTimeMs: Math.round(wallTimeMs * 100) / 100,
      throughputRps: throughput,
      p50: s.p50,
      p99: s.p99,
      errorsCount: errors,
    });

    log(`  c=${concurrency} wall=${fmt(wallTimeMs)} rps=${throughput} p50=${fmt(s.p50)} p99=${fmt(s.p99)}`);
  }

  return results;
}

// ── Runner ────────────────────────────────────────────────────────────────────

let silent = false;

function log(msg: string): void {
  if (!silent) console.log(msg);
}

export async function runBenchmarks(opts: { quiet?: boolean } = {}): Promise<BenchmarkReport> {
  silent = opts.quiet ?? false;

  process.env.FAULTLINE_API_KEY = 'bench-key';
  const server = buildServer();

  // Fastify needs to be ready before inject() works reliably
  await server.ready();

  try {
    // Warm-up pass — JIT-compile the hot path before recording measurements
    log('\n── Warm-up (discarded) ──────────────────────────────────────────────────');
    for (let i = 0; i < 10; i++) {
      await injectScan(server, `warmup ${i}`, 'mock');
    }
    resetCache();
    log('  done');

    log('\n── Provider latency (50 requests each, all cache MISS) ──────────────────');
    const providers = await benchmarkProviders(server);

    log('\n── Cache HIT vs MISS (50 requests each) ────────────────────────────────');
    const cache = await benchmarkCache(server);

    log('\n── Concurrent throughput ────────────────────────────────────────────────');
    const concurrency = await benchmarkConcurrency(server);

    const os = await import('node:os');

    const report: BenchmarkReport = {
      generatedAt: new Date().toISOString(),
      environment: {
        nodeVersion: process.version,
        platform: `${os.platform()}/${os.arch()}`,
        cpus: os.cpus().length,
        memoryMb: Math.round(os.totalmem() / 1024 / 1024),
      },
      providers,
      cache,
      concurrency,
    };

    return report;
  } finally {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  }
}

// ── Markdown formatter ────────────────────────────────────────────────────────

export function toMarkdown(r: BenchmarkReport): string {
  const d = new Date(r.generatedAt);
  const dateStr = d.toISOString().slice(0, 10);

  // Provider summary rows
  const hasRealProvider = r.providers.some((p) => p.provider !== 'mock' && p.isReal);
  const providerNotes = hasRealProvider
    ? '_Latency includes real LLM inference time. Mock row shows framework overhead only._'
    : '_All providers ran against mock scan engine (no API keys configured). Latency reflects framework overhead only (auth + cache + serialize). Add real API keys to measure true E2E latency._';

  const providerRows = r.providers.map((p) => {
    const tag = p.isReal && p.provider !== 'mock' ? '' : ' ¹';
    return `| ${(p.provider + tag).padEnd(14)} | ${p.n} | ${fmt(p.latency.p50)} | ${fmt(p.latency.p95)} | ${fmt(p.latency.p99)} | ${p.errorsCount} |`;
  });

  // Concurrency rows
  const concRows = r.concurrency.map((c) =>
    `| ${String(c.concurrency).padEnd(11)} | ${c.totalRequests} | ${Math.round(c.wallTimeMs)} ms | ${c.throughputRps.toLocaleString()} | ${fmt(c.p50)} | ${fmt(c.p99)} | ${c.errorsCount} |`,
  );

  return `# Faultline Pro — Performance Benchmarks

> **Methodology**: All benchmarks use Fastify \`server.inject()\` (in-process, no TCP overhead)
> unless a real provider API key is supplied. In-process measurements isolate framework and
> business-logic latency from network and LLM inference time.
> Percentiles computed from sorted samples using the index formula \`⌈p/100 × n⌉ − 1\`.
>
> **Environment**: ${r.environment.nodeVersion} · ${r.environment.platform} · ${r.environment.cpus} CPUs · ${r.environment.memoryMb} MB RAM
> **Generated**: ${dateStr}

---

## 1. Scan latency per provider (${r.providers[0]?.n ?? 50} requests, all cache MISS)

${providerNotes}

| Provider       | n   | p50    | p95    | p99    | Errors |
|----------------|-----|--------|--------|--------|--------|
${providerRows.join('\n')}

${hasRealProvider ? '' : '¹ Mock engine used (no API key configured).'}

**Framework overhead** (cache miss path): auth check → cache lookup → provider call → cache write
→ analytics record → webhook emit → audit log.

---

## 2. Cache performance (${r.cache.missN} MISS + ${r.cache.hitN} HIT requests)

| Path       | p50    | p90    | p95    | p99    |
|------------|--------|--------|--------|--------|
| Cache MISS | ${fmt(r.cache.missLatency.p50)} | ${fmt(r.cache.missLatency.p90)} | ${fmt(r.cache.missLatency.p95)} | ${fmt(r.cache.missLatency.p99)} |
| Cache HIT  | ${fmt(r.cache.hitLatency.p50)} | ${fmt(r.cache.hitLatency.p90)} | ${fmt(r.cache.hitLatency.p95)} | ${fmt(r.cache.hitLatency.p99)} |

**Measured hit ratio**: ${(r.cache.hitRatio * 100).toFixed(1)}%
**Speedup factor** (MISS p50 ÷ HIT p50): **${r.cache.speedupFactor}×** (in-process with mock engine)

> With a real LLM provider (500 ms – 5 s per scan), cache hits are **100–1000× faster**.
> Cache TTL default: 24 hours (configurable via \`FAULTLINE_CACHE_TTL_MS\`).

---

## 3. Concurrent scan throughput

| Concurrency | Requests | Wall time | Throughput | p50    | p99    | Errors |
|-------------|----------|-----------|:----------:|--------|--------|--------|
${concRows.join('\n')}

Concurrent requests fan out via \`Promise.all()\` inside Fastify's async handler.
Each concurrent scan is an independent cache miss with a full provider call.

---

## 4. Real-world provider estimates

> Estimates derived from published model latency benchmarks and Faultline framework overhead
> measured above. Run \`npx tsx packages/api/benchmarks/run.ts\` with real API keys to replace
> these estimates with measured values.

| Provider           | Framework overhead | Est. LLM inference | Est. total scan | Cost / 1K scans |
|--------------------|--------------------|-------------------|-----------------|:---------------:|
| Gemini 2.0 Flash   | ~${fmt(r.providers.find(p=>p.provider==='mock')?.latency.p50 ?? 2)} | ~1,500 ms | ~1,500 ms | ~$0.08 |
| GPT-4o             | ~${fmt(r.providers.find(p=>p.provider==='mock')?.latency.p50 ?? 2)} | ~2,800 ms | ~2,800 ms | ~$0.60 |
| Claude 3.5 Sonnet  | ~${fmt(r.providers.find(p=>p.provider==='mock')?.latency.p50 ?? 2)} | ~2,200 ms | ~2,200 ms | ~$0.45 |
| Perplexity Sonar   | ~${fmt(r.providers.find(p=>p.provider==='mock')?.latency.p50 ?? 2)} | ~1,800 ms | ~1,800 ms | ~$0.20 |
| Mock (no LLM)      | ~${fmt(r.providers.find(p=>p.provider==='mock')?.latency.p50 ?? 2)} | 0 ms | ~${fmt(r.providers.find(p=>p.provider==='mock')?.latency.p50 ?? 2)} | $0.00 |

---

## 5. Running benchmarks

\`\`\`bash
# Mock-only (no API keys required — measures framework overhead)
npx tsx packages/api/benchmarks/run.ts

# With real providers
GEMINI_API_KEY=<key> npx tsx packages/api/benchmarks/run.ts

# JSON output (for CI artifact storage)
npx tsx packages/api/benchmarks/run.ts --json > docs/benchmark-results.json

# Vitest suite (CI assertions — ensures p99 thresholds hold)
cd packages/api && npx vitest run tests/benchmark.test.ts
\`\`\`

---

*Benchmark runner: \`packages/api/benchmarks/run.ts\` · Report version: 2.0.0*
`;
}

// ── CLI entry ──────────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  const jsonMode = process.argv.includes('--json');

  runBenchmarks({ quiet: jsonMode })
    .then((report) => {
      if (jsonMode) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        console.log('\n' + toMarkdown(report));
      }
    })
    .catch((err) => {
      console.error('Benchmark failed:', err);
      process.exit(1);
    });
}
