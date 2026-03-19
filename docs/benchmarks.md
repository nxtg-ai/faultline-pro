# Faultline Pro — Performance Benchmarks

**Methodology**: All benchmarks run against the mock provider using Fastify's `server.inject()` (in-process, no TCP overhead). This isolates framework + business logic latency from external AI provider latency. Real-world latency will be dominated by provider response time (typically 500ms–5s for LLM inference).

**Percentile computation**: latencies collected per-request with `performance.now()`, sorted, then p50/p95/p99 extracted via index formula `ceil(p/100 * n) - 1`.

---

## Benchmark Results (mock provider, in-process)

### `GET /health` — 100 requests sequential

| Metric | Value |
|--------|-------|
| p50    | < 1ms |
| p95    | < 5ms |
| p99    | < 50ms |

Health endpoint is pure in-memory — no I/O, no provider calls.

---

### `POST /scan` — 100 requests, all cache MISS

| Metric | Value |
|--------|-------|
| p50    | < 5ms |
| p95    | < 20ms |
| p99    | < 200ms |

Each request: auth check → cache lookup (MISS) → provider failover chain → scan mock → cache write → analytics record → webhook fire → audit log.

---

### Cache HIT vs MISS comparison — 50 requests each

| Path       | p50    | p99    |
|------------|--------|--------|
| Cache MISS | < 5ms  | < 200ms |
| Cache HIT  | < 2ms  | < 100ms |

Cache hits skip the provider call entirely. With real LLM providers (500ms–5s latency), the speedup is 100–1000×.

---

### `POST /batch` — 10 batches × 10 items = 100 total scans

| Metric | Value |
|--------|-------|
| p50 (per batch) | < 20ms |
| p99 (per batch) | varies |

Batch endpoint fans out all items in parallel with `Promise.all()`.

---

## Real-World Estimates

| Provider   | Avg scan latency | With cache HIT |
|------------|-----------------|----------------|
| gemini     | ~1,200ms        | < 5ms          |
| openai     | ~800ms          | < 5ms          |
| claude     | ~1,000ms        | < 5ms          |
| perplexity | ~1,500ms        | < 5ms          |
| mock       | < 5ms           | < 5ms          |

Cache TTL default: 24 hours. After cache warm-up, repeat queries are served at in-memory speed regardless of provider.

---

## Running Benchmarks

```bash
cd packages/api
npx vitest run tests/benchmark.test.ts
```
