import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface ScanUsageStat {
  textHash:           string;
  textPreview:        string;
  scanCount:          number;
  firstScannedAt:     string;
  lastScannedAt:      string;
  daysSinceFirstScan: number;
  daysSinceLastScan:  number;
  latestRisk:         string;
  riskDrifted:        boolean;   // risk changed at least once across scans
  providers:          string[];  // distinct providers used
  avgLatencyMs:       number;
  isStale:            boolean;   // lastScan older than staleDays threshold
}

export interface ScanEntry {
  id: string;
  textHash: string;      // sha256 of original input text (enables timeline grouping)
  textPreview: string;   // first 100 chars of input text, anonymized (no full content)
  provider: string;
  overallRisk: string;
  claimCount: number;
  latencyMs: number;
  timestamp: string;     // ISO string
  keyId: string;
  tenantId?: string;     // resolved from TenantStore at record time; undefined for un-tenanted keys
}

export interface TimelineEntry extends ScanEntry {
  scanNumber:    number;
  claimDelta:    number;
  riskChanged:   boolean;
  previousRisk:  string | null;
}

const MAX_HISTORY = 1000;

class ScanHistoryStore {
  private entries: ScanEntry[] = [];

  record(entry: Omit<ScanEntry, 'id'>): ScanEntry {
    const stored: ScanEntry = { id: randomUUID(), ...entry };
    this.entries.unshift(stored);   // newest first
    if (this.entries.length > MAX_HISTORY) this.entries.length = MAX_HISTORY;
    return stored;
  }

  getRecent(limit = 10): ScanEntry[] {
    return this.entries.slice(0, limit);
  }

  search(params: {
    q?: string;
    from?: string;
    to?: string;
    provider?: string;
    risk?: string;
    cursor?: string;
    limit?: number;
    tenantId?: string;
  }): { entries: ScanEntry[]; nextCursor: string | null } {
    const limit = Math.min(params.limit ?? 20, 100);
    let results = this.entries; // already newest-first

    // Apply cursor (skip entries up to and including the cursor id)
    if (params.cursor) {
      const cursorIdx = results.findIndex((e) => e.id === params.cursor);
      if (cursorIdx !== -1) results = results.slice(cursorIdx + 1);
    }

    if (params.tenantId) results = results.filter((e) => e.tenantId === params.tenantId);
    if (params.q) {
      const q = params.q.toLowerCase();
      results = results.filter((e) => e.textPreview.toLowerCase().includes(q));
    }
    if (params.from) results = results.filter((e) => e.timestamp >= params.from!);
    if (params.to)   results = results.filter((e) => e.timestamp <= params.to!);
    if (params.provider) results = results.filter((e) => e.provider === params.provider);
    if (params.risk) results = results.filter((e) => e.overallRisk === params.risk);

    const page = results.slice(0, limit);
    const nextCursor = page.length === limit && results.length > limit ? page[page.length - 1].id : null;
    return { entries: page, nextCursor };
  }

  /**
   * Return all scans for a given textHash, oldest first (for timeline rendering).
   * Computes per-scan deltas: trustScore delta, new/resolved claims, risk changes.
   */
  getTimeline(textHash: string, limit = 50): TimelineEntry[] {
    const scans = this.entries
      .filter(e => e.textHash === textHash)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(0, limit);

    return scans.map((entry, idx) => {
      const prev = idx > 0 ? scans[idx - 1] : null;
      const claimDelta = prev !== null ? entry.claimCount - prev.claimCount : 0;
      const riskChanged = prev !== null && entry.overallRisk !== prev.overallRisk;
      return {
        ...entry,
        scanNumber: idx + 1,
        claimDelta,
        riskChanged,
        previousRisk: prev?.overallRisk ?? null,
      };
    });
  }

  /**
   * Returns per-textHash usage statistics with derived hygiene flags.
   * When tenantId is provided, only entries belonging to that tenant are included.
   */
  getScanUsageStats(staleDays = 30, tenantId?: string): ScanUsageStat[] {
    const now = Date.now();
    const msPerDay = 86_400_000;
    const staleCutoff = new Date(now - staleDays * msPerDay);

    // Group entries by textHash (filter by tenantId when specified)
    const groups = new Map<string, ScanEntry[]>();
    const source = tenantId ? this.entries.filter((e) => e.tenantId === tenantId) : this.entries;
    for (const entry of source) {
      const g = groups.get(entry.textHash) ?? [];
      g.push(entry);
      groups.set(entry.textHash, g);
    }

    const stats: ScanUsageStat[] = [];
    for (const [textHash, group] of groups) {
      const sorted = group.slice().sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
      const first = sorted[0];
      const last  = sorted[sorted.length - 1];

      const risks      = sorted.map((e) => e.overallRisk);
      const riskDrifted = new Set(risks).size > 1;
      const providers  = [...new Set(sorted.map((e) => e.provider))];
      const avgLatencyMs = Math.round(sorted.reduce((s, e) => s + e.latencyMs, 0) / sorted.length);

      const daysSinceFirstScan = Math.floor((now - new Date(first.timestamp).getTime()) / msPerDay);
      const daysSinceLastScan  = Math.floor((now - new Date(last.timestamp).getTime())  / msPerDay);
      const isStale            = new Date(last.timestamp) < staleCutoff;

      stats.push({
        textHash,
        textPreview:        first.textPreview,
        scanCount:          sorted.length,
        firstScannedAt:     first.timestamp,
        lastScannedAt:      last.timestamp,
        daysSinceFirstScan,
        daysSinceLastScan,
        latestRisk:         last.overallRisk,
        riskDrifted,
        providers,
        avgLatencyMs,
        isStale,
      });
    }

    // Sort by lastScannedAt descending (most recently scanned first)
    return stats.sort(
      (a, b) => new Date(b.lastScannedAt).getTime() - new Date(a.lastScannedAt).getTime(),
    );
  }

  /**
   * Deletes all scan entries belonging to stale textHash groups.
   * A group is stale when its most-recent scan is older than `days` days.
   * Returns the counts of deleted groups and individual entries.
   */
  pruneStaleGroups(days: number): { deletedGroups: number; deletedEntries: number } {
    const stale = this.getStaleScanGroups(days);
    if (stale.length === 0) return { deletedGroups: 0, deletedEntries: 0 };

    const staleHashes = new Set(stale.map((e) => e.textHash));
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !staleHashes.has(e.textHash));
    return { deletedGroups: staleHashes.size, deletedEntries: before - this.entries.length };
  }

  /**
   * Returns the most-recent scan entry per unique textHash group where
   * the most recent scan for that group is older than `days` days ago.
   * These are "stale" documents — texts that haven't been re-verified recently.
   * Results are sorted oldest-first.
   * When tenantId is provided, only entries belonging to that tenant are considered.
   */
  getStaleScanGroups(days: number, tenantId?: string): ScanEntry[] {
    const cutoff = new Date(Date.now() - days * 86_400_000);

    // Most recent entry per textHash (scoped to tenant when specified)
    const source = tenantId ? this.entries.filter((e) => e.tenantId === tenantId) : this.entries;
    const mostRecent = new Map<string, ScanEntry>();
    for (const entry of source) {
      const existing = mostRecent.get(entry.textHash);
      if (!existing || new Date(entry.timestamp) > new Date(existing.timestamp)) {
        mostRecent.set(entry.textHash, entry);
      }
    }

    return Array.from(mostRecent.values())
      .filter((e) => new Date(e.timestamp) < cutoff)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  get size(): number {
    return this.entries.length;
  }

  reset(): void {
    this.entries = [];
  }
}

let instance: ScanHistoryStore | null = null;

export function getScanHistory(): ScanHistoryStore {
  if (!instance) instance = new ScanHistoryStore();
  return instance;
}

export function resetScanHistory(): void {
  instance = new ScanHistoryStore();
}
