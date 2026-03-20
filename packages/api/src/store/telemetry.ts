/**
 * Telemetry Store — opt-in, privacy-preserving anonymous usage statistics.
 *
 * What IS recorded:
 *   provider, risk level, claim count, claim type distribution,
 *   latency bucket, input length bucket, cache-hit flag, hour-truncated timestamp.
 *
 * What is NEVER recorded:
 *   text content, keyId, IP address, file names, user identity,
 *   exact timestamps (truncated to the hour), exact input length (bucketed).
 *
 * Opt-in: controlled by FAULTLINE_TELEMETRY=1 environment variable.
 *         Off by default. No data is collected when the flag is absent.
 *
 * Retention: in-memory only. Data is cleared on server restart.
 *            No data is written to disk or sent to external services.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type LatencyBucket = '<100ms' | '100-500ms' | '500ms-2s' | '>2s';
export type InputLengthBucket = '<500' | '500-2000' | '2000-10000' | '>10000';

export interface TelemetryEvent {
  /** ISO datetime truncated to the hour — no exact timing */
  hour: string;
  provider: string;
  riskLevel: string;
  claimCount: number;
  /** Distribution of claim types — no claim text */
  claimTypes: Record<string, number>;
  latencyBucket: LatencyBucket;
  inputLengthBucket: InputLengthBucket;
  cacheHit: boolean;
  errorCode?: number;
}

export interface ProviderStats {
  count:     number;
  pct:       number;
  errorRate: number;
}

export interface HourlyBucket {
  hour:       string;
  count:      number;
  errorRate:  number;
}

export interface TelemetryDashboard {
  generatedAt:  string;
  optInEnabled: boolean;
  privacy: {
    version:            string;
    dataRetentionDays:  number;
    noTextContent:      boolean;
    noUserIdentity:     boolean;
    noIpAddress:        boolean;
    timestampPrecision: string;
  };
  totals: {
    events:     number;
    cacheHits:  number;
    errors:     number;
    errorRate:  number;
  };
  providers:           Record<string, ProviderStats>;
  riskDistribution:    Record<string, number>;
  latencyDistribution: Record<string, number>;
  inputLengthDistribution: Record<string, number>;
  claimTypes:          Record<string, number>;
  hourly:              HourlyBucket[];
  avgClaimsPerScan:    number;
}

// ── Bucketing helpers (exported for testing) ──────────────────────────────────

export function latencyBucket(ms: number): LatencyBucket {
  if (ms < 100)   return '<100ms';
  if (ms < 500)   return '100-500ms';
  if (ms < 2000)  return '500ms-2s';
  return '>2s';
}

export function inputLengthBucket(len: number): InputLengthBucket {
  if (len < 500)   return '<500';
  if (len < 2000)  return '500-2000';
  if (len < 10000) return '2000-10000';
  return '>10000';
}

/** Truncate an ISO timestamp to the hour: "2026-03-20T22:00:00.000Z" */
export function truncateToHour(iso: string): string {
  return iso.slice(0, 13) + ':00:00.000Z';
}

// ── Store ─────────────────────────────────────────────────────────────────────

const MAX_EVENTS = 50_000;

class TelemetryStore {
  private events: TelemetryEvent[] = [];

  isEnabled(): boolean {
    return process.env.FAULTLINE_TELEMETRY === '1';
  }

  record(event: TelemetryEvent): void {
    if (!this.isEnabled()) return;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  getDashboard(): TelemetryDashboard {
    const events = this.events;
    const total  = events.length;

    const errors    = events.filter(e => e.errorCode !== undefined).length;
    const cacheHits = events.filter(e => e.cacheHit).length;

    // Provider breakdown
    const providerCounts = new Map<string, { total: number; errors: number }>();
    for (const e of events) {
      const p = providerCounts.get(e.provider) ?? { total: 0, errors: 0 };
      p.total++;
      if (e.errorCode) p.errors++;
      providerCounts.set(e.provider, p);
    }
    const providers: Record<string, ProviderStats> = {};
    for (const [name, stats] of providerCounts) {
      providers[name] = {
        count:     stats.total,
        pct:       total > 0 ? Math.round((stats.total / total) * 100) : 0,
        errorRate: stats.total > 0 ? Math.round((stats.errors / stats.total) * 100) / 100 : 0,
      };
    }

    // Risk distribution
    const riskDistribution: Record<string, number> = {};
    for (const e of events) {
      riskDistribution[e.riskLevel] = (riskDistribution[e.riskLevel] ?? 0) + 1;
    }

    // Latency distribution
    const latencyDistribution: Record<string, number> = {};
    for (const e of events) {
      latencyDistribution[e.latencyBucket] = (latencyDistribution[e.latencyBucket] ?? 0) + 1;
    }

    // Input length distribution
    const inputLengthDistribution: Record<string, number> = {};
    for (const e of events) {
      inputLengthDistribution[e.inputLengthBucket] = (inputLengthDistribution[e.inputLengthBucket] ?? 0) + 1;
    }

    // Claim type aggregation
    const claimTypes: Record<string, number> = {};
    for (const e of events) {
      for (const [type, count] of Object.entries(e.claimTypes)) {
        claimTypes[type] = (claimTypes[type] ?? 0) + count;
      }
    }

    // Avg claims per scan (exclude error events)
    const successEvents = events.filter(e => !e.errorCode);
    const avgClaimsPerScan = successEvents.length > 0
      ? Math.round((successEvents.reduce((s, e) => s + e.claimCount, 0) / successEvents.length) * 10) / 10
      : 0;

    // Hourly breakdown — last 24 hours
    const now   = new Date();
    const hours: HourlyBucket[] = [];
    for (let i = 23; i >= 0; i--) {
      const t  = new Date(now.getTime() - i * 3_600_000);
      const hr = truncateToHour(t.toISOString()).slice(0, 13); // "2026-03-20T22"
      const bucket = events.filter(e => e.hour.startsWith(hr));
      const bucketErrors = bucket.filter(e => e.errorCode).length;
      hours.push({
        hour:      hr,
        count:     bucket.length,
        errorRate: bucket.length > 0
          ? Math.round((bucketErrors / bucket.length) * 100) / 100
          : 0,
      });
    }

    return {
      generatedAt:  new Date().toISOString(),
      optInEnabled: this.isEnabled(),
      privacy: {
        version:            '1.0',
        dataRetentionDays:  0, // in-memory only, cleared on restart
        noTextContent:      true,
        noUserIdentity:     true,
        noIpAddress:        true,
        timestampPrecision: 'hour',
      },
      totals: {
        events: total,
        cacheHits,
        errors,
        errorRate: total > 0 ? Math.round((errors / total) * 100) / 100 : 0,
      },
      providers,
      riskDistribution,
      latencyDistribution,
      inputLengthDistribution,
      claimTypes,
      hourly:           hours,
      avgClaimsPerScan,
    };
  }

  getEvents(): TelemetryEvent[] {
    return this.events.slice();
  }

  reset(): void {
    this.events = [];
  }
}

let instance: TelemetryStore | null = null;

export function getTelemetryStore(): TelemetryStore {
  if (!instance) instance = new TelemetryStore();
  return instance;
}

export function resetTelemetryStore(): void {
  instance = new TelemetryStore();
}

// ── Convenience recorder ──────────────────────────────────────────────────────

export interface ScanTelemetryInput {
  provider:    string;
  riskLevel:   string;
  claimCount:  number;
  claimTypes:  Record<string, number>;
  latencyMs:   number;
  inputLength: number;
  cacheHit:    boolean;
  errorCode?:  number;
}

export function recordScanTelemetry(input: ScanTelemetryInput): void {
  getTelemetryStore().record({
    hour:               truncateToHour(new Date().toISOString()),
    provider:           input.provider,
    riskLevel:          input.riskLevel,
    claimCount:         input.claimCount,
    claimTypes:         input.claimTypes,
    latencyBucket:      latencyBucket(input.latencyMs),
    inputLengthBucket:  inputLengthBucket(input.inputLength),
    cacheHit:           input.cacheHit,
    errorCode:          input.errorCode,
  });
}
