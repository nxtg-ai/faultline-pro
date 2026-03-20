/**
 * Status store — uptime tracking and derived status data.
 * Incidents and response-time buckets are computed from the audit log
 * on demand; no separate state is maintained.
 */

import type { AuditEntry } from './audit.js';

// ── Uptime ────────────────────────────────────────────────────────────────────

let _startTime = Date.now();

export function getUptimeMs(): number {
  return Date.now() - _startTime;
}

/** Reset for tests — restores start time to now. */
export function resetStatusClock(): void {
  _startTime = Date.now();
}

export function formatUptime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const days      = Math.floor(totalSecs / 86400);
  const hrs       = Math.floor((totalSecs % 86400) / 3600);
  const mins      = Math.floor((totalSecs % 3600) / 60);
  const secs      = totalSecs % 60;

  if (days > 0)  return `${days}d ${hrs}h ${mins}m`;
  if (hrs > 0)   return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0)  return `${mins}m ${secs}s`;
  return `${secs}s`;
}

// ── Incidents ─────────────────────────────────────────────────────────────────

export type IncidentType = 'error' | 'latency';

export interface DerivedIncident {
  timestamp: string;
  type: IncidentType;
  description: string;
}

const HIGH_LATENCY_MS = 5_000;

/**
 * Auto-derive incidents from the audit log.
 * Treats HTTP 5xx responses and requests taking > 5 s as incidents.
 * Returns the most-recent `limit` incidents, newest first.
 */
export function deriveIncidents(entries: AuditEntry[], limit = 10): DerivedIncident[] {
  const incidents: DerivedIncident[] = [];
  for (const e of entries) {
    if (e.statusCode >= 500) {
      incidents.push({
        timestamp: e.timestamp,
        type: 'error',
        description: `${e.method} ${e.endpoint} → HTTP ${e.statusCode}`,
      });
    } else if (e.latencyMs > HIGH_LATENCY_MS) {
      incidents.push({
        timestamp: e.timestamp,
        type: 'latency',
        description: `${e.method} ${e.endpoint} — ${e.latencyMs} ms`,
      });
    }
  }
  return incidents.slice(-limit).reverse();
}

// ── Response-time buckets ─────────────────────────────────────────────────────

export interface TimeBucket {
  label: string;   // "HH:MM"
  p50Ms: number;
  count: number;
}

/**
 * Bucket audit-log latencies into 1-minute slots over the last `windowMs`.
 * Buckets with no requests get p50 = 0.
 */
export function bucketResponseTimes(
  entries: AuditEntry[],
  windowMs: number  = 60 * 60 * 1_000,  // 60 min
  bucketMs: number  = 60 * 1_000,        // 1 min
): TimeBucket[] {
  const now          = Date.now();
  const bucketCount  = Math.floor(windowMs / bucketMs);

  const slots: number[][] = Array.from({ length: bucketCount }, () => []);
  const labels: string[]  = Array.from({ length: bucketCount }, (_, i) => {
    const t = new Date(now - (bucketCount - 1 - i) * bucketMs);
    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  });

  for (const e of entries) {
    const age = now - new Date(e.timestamp).getTime();
    if (age < 0 || age > windowMs) continue;
    // Newest entries → highest index; age=0 → bucketCount-1, age=windowMs → 0
    const idx = bucketCount - 1 - Math.min(bucketCount - 1, Math.floor(age / bucketMs));
    slots[idx].push(e.latencyMs);
  }

  return slots.map((vals, i) => ({
    label:  labels[i]!,
    p50Ms:  vals.length === 0 ? 0 : vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)]!,
    count:  vals.length,
  }));
}
