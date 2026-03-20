# Faultline Pro — Performance Benchmarks

> **Methodology**: All benchmarks use Fastify `server.inject()` (in-process, no TCP overhead)
> unless a real provider API key is supplied. In-process measurements isolate framework and
> business-logic latency from network and LLM inference time.
> Percentiles computed from sorted samples using the index formula `⌈p/100 × n⌉ − 1`.
>
> **Environment**: v22.21.1 · linux/x64 · 32 CPUs · 64172 MB RAM
> **Generated**: 2026-03-20

---

## 1. Scan latency per provider (50 requests, all cache MISS)

_All providers ran against mock scan engine (no API keys configured). Latency reflects framework overhead only (auth + cache + serialize). Add real API keys to measure true E2E latency._

| Provider       | n   | p50    | p95    | p99    | Errors |
|----------------|-----|--------|--------|--------|--------|
| gemini ¹       | 50 | 257µs | 398µs | 551µs | 0 |
| openai ¹       | 50 | 237µs | 309µs | 387µs | 0 |
| claude ¹       | 50 | 261µs | 321µs | 2.13ms | 0 |
| perplexity ¹   | 50 | 219µs | 292µs | 311µs | 0 |
| mock ¹         | 50 | 246µs | 394µs | 557µs | 0 |

¹ Mock engine used (no API key configured).

**Framework overhead** (cache miss path): auth check → cache lookup → provider call → cache write
→ analytics record → webhook emit → audit log.

---

## 2. Cache performance (50 MISS + 50 HIT requests)

| Path       | p50    | p90    | p95    | p99    |
|------------|--------|--------|--------|--------|
| Cache MISS | 213µs | 284µs | 308µs | 1.67ms |
| Cache HIT  | 128µs | 206µs | 219µs | 261µs |

**Measured hit ratio**: 49.5%
**Speedup factor** (MISS p50 ÷ HIT p50): **1.7×** (in-process with mock engine)

> With a real LLM provider (500 ms – 5 s per scan), cache hits are **100–1000× faster**.
> Cache TTL default: 24 hours (configurable via `FAULTLINE_CACHE_TTL_MS`).

---

## 3. Concurrent scan throughput

| Concurrency | Requests | Wall time | Throughput | p50    | p99    | Errors |
|-------------|----------|-----------|:----------:|--------|--------|--------|
| 5           | 5 | 1 ms | 5,732 | 631µs | 841µs | 0 |
| 10          | 10 | 2 ms | 5,750 | 1.15ms | 1.72ms | 0 |
| 25          | 25 | 4 ms | 7,138 | 2.16ms | 3.46ms | 0 |
| 50          | 50 | 5 ms | 9,101 | 3.40ms | 5.43ms | 0 |

Concurrent requests fan out via `Promise.all()` inside Fastify's async handler.
Each concurrent scan is an independent cache miss with a full provider call.

---

## 4. Real-world provider estimates

> Estimates derived from published model latency benchmarks and Faultline framework overhead
> measured above. Run `npx tsx packages/api/benchmarks/run.ts` with real API keys to replace
> these estimates with measured values.

| Provider           | Framework overhead | Est. LLM inference | Est. total scan | Cost / 1K scans |
|--------------------|--------------------|-------------------|-----------------|:---------------:|
| Gemini 2.0 Flash   | ~246µs | ~1,500 ms | ~1,500 ms | ~$0.08 |
| GPT-4o             | ~246µs | ~2,800 ms | ~2,800 ms | ~$0.60 |
| Claude 3.5 Sonnet  | ~246µs | ~2,200 ms | ~2,200 ms | ~$0.45 |
| Perplexity Sonar   | ~246µs | ~1,800 ms | ~1,800 ms | ~$0.20 |
| Mock (no LLM)      | ~246µs | 0 ms | ~246µs | $0.00 |

---

## 5. Running benchmarks

```bash
# Mock-only (no API keys required — measures framework overhead)
npx tsx packages/api/benchmarks/run.ts

# With real providers
GEMINI_API_KEY=<key> npx tsx packages/api/benchmarks/run.ts

# JSON output (for CI artifact storage)
npx tsx packages/api/benchmarks/run.ts --json > docs/benchmark-results.json

# Vitest suite (CI assertions — ensures p99 thresholds hold)
cd packages/api && npx vitest run tests/benchmark.test.ts
```

---

*Benchmark runner: `packages/api/benchmarks/run.ts` · Report version: 2.0.0*

