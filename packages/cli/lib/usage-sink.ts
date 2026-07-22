/**
 * usage-sink.ts — per-scan real-usage collector (BLG-CLX9-20260703-005 defect 1).
 *
 * The engine currently DISCARDS provider-reported token usage (the measurement
 * harness only recovered it by monkeypatching global fetch). This is the
 * first-class seam that lets the provider adapters + the web_search Retriever
 * emit their real `usage.*` to the scan in flight, so production telemetry can
 * price the fan-out from measured tokens instead of a text-length estimate.
 *
 * CONCURRENCY: the collector is AsyncLocalStorage-scoped, NOT a module global.
 * The Fastify API runs many scans at once; a module-level array would
 * cross-attribute one request's usage onto another — green on every sequential
 * unit test, silently wrong in prod. ALS gives each scan an isolated collector
 * and needs no collector param threaded through the engine. Works identically
 * for the standalone CLI (one scope) and the concurrent API (many scopes).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** One LLM/retrieval call's real provider-reported usage. */
export interface UsageLeg {
  /** Real model ID from the response (undefined when the wire didn't carry it). */
  model?: string;
  /** Call type: extraction · grounded-verify:<provider> · web_search. */
  callType?: string;
  /** Provider family (openai · gemini · anthropic) — diagnostic. */
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  /** True for the web_search / grounded-retrieval tool call (bills per call). */
  isGrounding: boolean;
}

const storage = new AsyncLocalStorage<UsageLeg[]>();

/**
 * Run `fn` inside a fresh per-scan usage-capture scope. Any `recordUsage()`
 * called (synchronously or across awaits) within `fn` lands in THIS scope's
 * isolated collector. Returns the fn result plus the collected legs.
 */
export async function captureUsage<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; legs: UsageLeg[] }> {
  const legs: UsageLeg[] = [];
  const result = await storage.run(legs, fn);
  return { result, legs };
}

/**
 * Record one call's real usage into the active scan's collector.
 * No-op outside a `captureUsage()` scope (direct CLI calls, unit tests) — it
 * never throws and leaves the hot path byte-for-byte unchanged when capture is
 * not wired, honoring the base_provider additive-seam contract.
 */
export function recordUsage(leg: UsageLeg): void {
  const legs = storage.getStore();
  if (legs) legs.push(leg);
}

/** True when a capture scope is currently active (diagnostic / testing). */
export function isCapturing(): boolean {
  return storage.getStore() !== undefined;
}
