/**
 * Provider Plugin System (D-124)
 *
 * FaultlineProvider interface + ProviderRegistry singleton.
 * Tracks per-provider latency and health for D-125 auto-rotation.
 */

/** Auto-disable: if error rate in the last N calls exceeds this, provider is disabled. */
export const AUTO_DISABLE_THRESHOLD = 0.8;   // 80% errors
export const AUTO_DISABLE_WINDOW    = 10;    // over last 10 calls
const MAX_TIME_SERIES               = 120;   // per provider (last 120 data points)

export interface HealthDataPoint {
  timestamp: string;  // ISO
  latencyMs: number;
  success:   boolean;
}

export interface VerificationResult {
  status: 'supported' | 'contradicted' | 'mixed' | 'unverified';
  explanation: string;
  confidence: number;
}

export interface FaultlineProvider {
  name: string;
  verify(claim: string): Promise<VerificationResult>;
}

export interface ProviderPlugin {
  name: string;
  endpoint: string;
  authHeader?: string;
}

interface ProviderHealth {
  totalRequests: number;
  totalErrors: number;
  totalLatencyMs: number;
  lastLatencyMs: number;
  available:     boolean;
  disabled:      boolean;
  disabledAt?:   string;
  disabledReason?: string;
  timeSeries:    HealthDataPoint[];
}

class ProviderRegistry {
  private plugins = new Map<string, ProviderPlugin>();
  private providers = new Map<string, FaultlineProvider>();
  private health = new Map<string, ProviderHealth>();

  private getHealth(name: string): ProviderHealth {
    if (!this.health.has(name)) {
      this.health.set(name, {
        totalRequests: 0,
        totalErrors: 0,
        totalLatencyMs: 0,
        lastLatencyMs: 0,
        available: true,
        disabled: false,
        timeSeries: [],
      });
    }
    return this.health.get(name)!;
  }

  private checkAutoDisable(name: string): void {
    const h = this.getHealth(name);
    if (h.disabled) return; // already disabled
    const window = h.timeSeries.slice(-AUTO_DISABLE_WINDOW);
    if (window.length < AUTO_DISABLE_WINDOW) return;
    const errorCount = window.filter(p => !p.success).length;
    const errorRate = errorCount / window.length;
    if (errorRate >= AUTO_DISABLE_THRESHOLD) {
      h.disabled = true;
      h.disabledAt = new Date().toISOString();
      h.disabledReason = `Auto-disabled: ${Math.round(errorRate * 100)}% error rate over last ${AUTO_DISABLE_WINDOW} calls.`;
      h.available = false;
    }
  }

  /** Register a plugin (external HTTP endpoint) */
  registerPlugin(plugin: ProviderPlugin): void {
    this.plugins.set(plugin.name, plugin);
    // Create an HTTP-backed provider wrapper
    const provider: FaultlineProvider = {
      name: plugin.name,
      verify: async (claim: string): Promise<VerificationResult> => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (plugin.authHeader) headers['Authorization'] = plugin.authHeader;
        const res = await fetch(plugin.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ claim }),
        });
        if (!res.ok) throw new Error(`Plugin ${plugin.name} returned ${res.status}`);
        return res.json() as Promise<VerificationResult>;
      },
    };
    this.providers.set(plugin.name, provider);
  }

  /** Register a built-in provider directly */
  registerProvider(provider: FaultlineProvider): void {
    this.providers.set(provider.name, provider);
  }

  getPlugin(name: string): ProviderPlugin | undefined {
    return this.plugins.get(name);
  }

  listPlugins(): ProviderPlugin[] {
    return Array.from(this.plugins.values());
  }

  listProviders(): FaultlineProvider[] {
    return Array.from(this.providers.values());
  }

  getProvider(name: string): FaultlineProvider | undefined {
    return this.providers.get(name);
  }

  /** Record a successful call with its latency */
  recordSuccess(name: string, latencyMs: number): void {
    const h = this.getHealth(name);
    h.totalRequests++;
    h.totalLatencyMs += latencyMs;
    h.lastLatencyMs = latencyMs;
    if (!h.disabled) h.available = true;
    h.timeSeries.push({ timestamp: new Date().toISOString(), latencyMs, success: true });
    if (h.timeSeries.length > MAX_TIME_SERIES) h.timeSeries.shift();
    this.checkAutoDisable(name);
  }

  /** Record a failed call */
  recordError(name: string): void {
    const h = this.getHealth(name);
    h.totalRequests++;
    h.totalErrors++;
    h.available = false;
    h.timeSeries.push({ timestamp: new Date().toISOString(), latencyMs: 0, success: false });
    if (h.timeSeries.length > MAX_TIME_SERIES) h.timeSeries.shift();
    this.checkAutoDisable(name);
  }

  /** Admin: manually disable a provider */
  setDisabled(name: string, reason = 'Manually disabled by admin.'): void {
    const h = this.getHealth(name);
    h.disabled = true;
    h.available = false;
    h.disabledAt = new Date().toISOString();
    h.disabledReason = reason;
  }

  /** Admin: re-enable a previously disabled provider */
  setEnabled(name: string): void {
    const h = this.getHealth(name);
    h.disabled = false;
    h.available = true;
    h.disabledAt = undefined;
    h.disabledReason = undefined;
  }

  /** Check if a provider is currently disabled */
  isDisabled(name: string): boolean {
    return this.getHealth(name).disabled;
  }

  /** Get health snapshot for all tracked providers */
  getHealthSnapshot(): Record<string, {
    available:      boolean;
    disabled:       boolean;
    disabledAt:     string | undefined;
    disabledReason: string | undefined;
    errorRate:      number;
    avgLatencyMs:   number;
    lastLatencyMs:  number;
    totalRequests:  number;
    healthScore:    number;
    timeSeries:     HealthDataPoint[];
  }> {
    const result: Record<string, ReturnType<ProviderRegistry['getHealthSnapshot']>[string]> = {};
    for (const [name, h] of this.health.entries()) {
      const errorRate = h.totalRequests > 0 ? h.totalErrors / h.totalRequests : 0;
      const avgLatencyMs = h.totalRequests > h.totalErrors
        ? h.totalLatencyMs / (h.totalRequests - h.totalErrors)
        : 0;
      // Health score: higher is better. Range 0–1000.
      const healthScore = h.disabled ? 0 : (1 - errorRate) * (1000 / (avgLatencyMs + 1));
      result[name] = {
        available:      h.available,
        disabled:       h.disabled,
        disabledAt:     h.disabledAt,
        disabledReason: h.disabledReason,
        errorRate,
        avgLatencyMs,
        lastLatencyMs:  h.lastLatencyMs,
        totalRequests:  h.totalRequests,
        healthScore,
        timeSeries:     [...h.timeSeries],
      };
    }
    return result;
  }

  reset(): void {
    this.plugins.clear();
    this.providers.clear();
    this.health.clear();
  }
}

let instance: ProviderRegistry | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (!instance) instance = new ProviderRegistry();
  return instance;
}

export function resetProviderRegistry(): void {
  instance = new ProviderRegistry();
}
