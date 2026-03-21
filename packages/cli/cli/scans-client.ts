/**
 * Scan history HTTP client for the Faultline CLI.
 * Talks to the Faultline API server's /scans endpoints.
 */

export interface ScanEntry {
  id: string;
  textHash: string;
  textPreview: string;
  provider: string;
  overallRisk: string;
  claimCount: number;
  latencyMs: number;
  timestamp: string;
  keyId: string;
}

export interface StaleScanResult {
  days: number;
  count: number;
  scans: ScanEntry[];
  error?: string;
}

export interface ScanUsageStat {
  textHash: string;
  textPreview: string;
  scanCount: number;
  firstScannedAt: string;
  lastScannedAt: string;
  daysSinceFirstScan: number;
  daysSinceLastScan: number;
  latestRisk: string;
  riskDrifted: boolean;
  providers: string[];
  avgLatencyMs: number;
  isStale: boolean;
}

export interface ScanUsageResult {
  staleDays: number;
  total: number;
  staleCount: number;
  riskDriftedCount: number;
  stats: ScanUsageStat[];
  error?: string;
}

async function apiFetch(url: string, apiKey: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `HTTP ${res.status}`;
    return { error: msg };
  }
  return body;
}

export async function getStaleScans(apiUrl: string, apiKey: string, days: number): Promise<StaleScanResult> {
  const result = await apiFetch(`${apiUrl}/scans/stale?days=${days}`, apiKey);
  if ((result as { error?: string }).error) {
    return { days, count: 0, scans: [], error: (result as { error: string }).error };
  }
  return result as StaleScanResult;
}

export async function getScanUsage(apiUrl: string, apiKey: string, staleDays: number): Promise<ScanUsageResult> {
  const result = await apiFetch(`${apiUrl}/scans/usage?staleDays=${staleDays}`, apiKey);
  if ((result as { error?: string }).error) {
    return { staleDays, total: 0, staleCount: 0, riskDriftedCount: 0, stats: [], error: (result as { error: string }).error };
  }
  return result as ScanUsageResult;
}

// ── Formatters ───────────────────────────────────────────────────────────────

export function formatStaleList(result: StaleScanResult): string {
  if (result.count === 0) return `No stale scans found (threshold: ${result.days} days).`;
  const lines = [`Stale scans — not re-verified in >${result.days} days (${result.count}):`, ''];
  for (const s of result.scans) {
    const daysSince = Math.floor((Date.now() - new Date(s.timestamp).getTime()) / 86_400_000);
    const preview = s.textPreview.slice(0, 50).padEnd(52);
    const risk    = s.overallRisk.padEnd(10);
    lines.push(`  ${s.textHash.slice(0, 8)}  ${preview}  ${risk}  ${daysSince}d ago  ${s.provider}`);
  }
  return lines.join('\n');
}

export function formatScanUsage(result: ScanUsageResult): string {
  const lines = [
    `Scan usage summary (staleDays: ${result.staleDays}):`,
    '',
    `  Total documents:   ${result.total}`,
    `  Stale:             ${result.staleCount}`,
    `  Risk drifted:      ${result.riskDriftedCount}`,
  ];

  if (result.stats.length === 0) {
    lines.push('', '  No scan history found.');
    return lines.join('\n');
  }

  lines.push('', '  Hash      Preview                                       Risk       Scans  Last Seen');
  lines.push('  ' + '-'.repeat(84));
  for (const s of result.stats) {
    const preview  = s.textPreview.slice(0, 48).padEnd(50);
    const risk     = s.latestRisk.padEnd(10);
    const scans    = String(s.scanCount).padStart(5);
    const lastSeen = `${s.daysSinceLastScan}d ago`;
    const flags    = [s.isStale ? 'STALE' : '', s.riskDrifted ? 'DRIFT' : ''].filter(Boolean).join(' ');
    const flagStr  = flags ? `  [${flags}]` : '';
    lines.push(`  ${s.textHash.slice(0, 8)}  ${preview}  ${risk}${scans}  ${lastSeen}${flagStr}`);
  }
  return lines.join('\n');
}
