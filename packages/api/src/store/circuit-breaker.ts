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

  /** Returns ordered list of providers to try, skipping DOWN ones */
  getChain(preferred?: Provider): Provider[] {
    const ordered = preferred
      ? [preferred, ...PROVIDER_CHAIN.filter(p => p !== preferred)]
      : [...PROVIDER_CHAIN];
    return ordered.filter(p => !this.isDown(p));
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
