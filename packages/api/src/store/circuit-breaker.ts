export type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

export const PROVIDER_CHAIN: Provider[] = ['gemini', 'openai', 'claude', 'perplexity', 'mock'];

const FAILURE_THRESHOLD = 5; // failures before marking DOWN
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

interface ProviderState {
  consecutiveFailures: number;
  downUntil: number | null;
  totalRequests: number;
  totalErrors: number;
  totalLatencyMs: number;
  lastLatencyMs: number;
}

class CircuitBreaker {
  private states = new Map<Provider, ProviderState>();

  private getState(provider: Provider): ProviderState {
    if (!this.states.has(provider)) {
      this.states.set(provider, {
        consecutiveFailures: 0,
        downUntil: null,
        totalRequests: 0,
        totalErrors: 0,
        totalLatencyMs: 0,
        lastLatencyMs: 0,
      });
    }
    return this.states.get(provider)!;
  }

  isDown(provider: Provider): boolean {
    const state = this.getState(provider);
    if (state.downUntil === null) return false;
    if (Date.now() >= state.downUntil) {
      state.consecutiveFailures = 0;
      state.downUntil = null;
      return false;
    }
    return true;
  }

  recordSuccess(provider: Provider, latencyMs?: number): void {
    const state = this.getState(provider);
    state.consecutiveFailures = 0;
    state.downUntil = null;
    state.totalRequests++;
    if (latencyMs !== undefined) {
      state.totalLatencyMs += latencyMs;
      state.lastLatencyMs = latencyMs;
    }
  }

  recordFailure(provider: Provider): void {
    const state = this.getState(provider);
    state.consecutiveFailures++;
    state.totalRequests++;
    state.totalErrors++;
    if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
      state.downUntil = Date.now() + COOLDOWN_MS;
    }
  }

  /** Health score for a provider — higher is healthier. Used for auto-rotation sorting. */
  healthScore(provider: Provider): number {
    const s = this.getState(provider);
    if (this.isDown(provider)) return 0;
    const errorRate = s.totalRequests > 0 ? s.totalErrors / s.totalRequests : 0;
    const successCount = s.totalRequests - s.totalErrors;
    const avgLatencyMs = successCount > 0 ? s.totalLatencyMs / successCount : 0;
    return (1 - errorRate) * (1000 / (avgLatencyMs + 1));
  }

  /**
   * Returns ordered list of providers to try, skipping DOWN ones.
   *
   * `mock` is a test double (one claim per sentence, every verdict "supported"),
   * so it is tried only when the caller asked for it, never as a fallback: a scan
   * whose real providers all failed (e.g. an extraction 429 or truncated reply)
   * must report a failure, not return mock verdicts as a 200.
   */
  getChain(preferred?: Provider): Provider[] {
    const fallbacks = PROVIDER_CHAIN.filter(p => p !== preferred && p !== 'mock');
    const ordered = preferred ? [preferred, ...fallbacks] : fallbacks;
    return ordered.filter(p => !this.isDown(p));
  }

  /**
   * The one provider a hosted scan may use: the caller's named provider, else
   * Gemini. Empty when that provider is DOWN, so the route answers 503.
   *
   * There is no cross-provider fallback. The privacy page names the providers a
   * scan's text goes to (Gemini; OpenAI and Anthropic only on an Enterprise
   * consensus scan), and in the parallel grounding mode only a Gemini verify
   * judges against Parallel sources. Falling over to OpenAI or Claude on a
   * Gemini error would send the text to a provider the caller was not told
   * about and judge it without those sources (Show HN review, blocker 4).
   * getChain stays for the status surfaces.
   */
  getScanRoute(preferred?: Provider): Provider[] {
    const p = preferred ?? 'gemini';
    return this.isDown(p) ? [] : [p];
  }

  getStatus(): Record<Provider, { down: boolean; consecutiveFailures: number; healthScore: number }> {
    const result = {} as Record<Provider, { down: boolean; consecutiveFailures: number; healthScore: number }>;
    for (const p of PROVIDER_CHAIN) {
      result[p] = {
        down: this.isDown(p),
        consecutiveFailures: this.getState(p).consecutiveFailures,
        healthScore: this.healthScore(p),
      };
    }
    return result;
  }

  reset(): void {
    this.states.clear();
  }
}

let instance: CircuitBreaker | null = null;

export function getCircuitBreaker(): CircuitBreaker {
  if (!instance) instance = new CircuitBreaker();
  return instance;
}

export function resetCircuitBreaker(): void {
  instance = new CircuitBreaker();
}
