/**
 * npm Download Metrics Store (N-185)
 *
 * Time-series store for daily npm download counts.
 * Fetches from the public npmjs.org API: https://api.npmjs.org/downloads/range/
 * No authentication required.
 */

export interface DailyDownload {
  day: string;        // YYYY-MM-DD
  downloads: number;
}

export interface PackageDownloads {
  package: string;
  downloads: DailyDownload[];
  totalDownloads: number;
  lastFetched: string;  // ISO timestamp
}

export interface NpmOverview {
  packages: PackageDownloads[];
  grandTotal: number;
  period: { start: string; end: string };
  fetchedAt: string;
}

/** Packages we track. */
const TRACKED_PACKAGES = ['@nxtg/faultline', '@nxtg/faultline-api', '@nxtg/faultline-sdk'];

class NpmMetricsStore {
  private data: Map<string, PackageDownloads> = new Map();
  private lastPolled: string | null = null;
  private pollIntervalMs = 3_600_000; // 1 hour default
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Record download data for a package (used by the poller and tests). */
  record(pkg: string, downloads: DailyDownload[]): PackageDownloads {
    const total = downloads.reduce((sum, d) => sum + d.downloads, 0);
    const entry: PackageDownloads = {
      package: pkg,
      downloads,
      totalDownloads: total,
      lastFetched: new Date().toISOString(),
    };
    this.data.set(pkg, entry);
    this.lastPolled = entry.lastFetched;
    return entry;
  }

  /** Get download data for a single package. */
  get(pkg: string): PackageDownloads | null {
    return this.data.get(pkg) ?? null;
  }

  /** Get overview across all tracked packages. */
  getOverview(): NpmOverview {
    const packages = [...this.data.values()];
    const grandTotal = packages.reduce((s, p) => s + p.totalDownloads, 0);

    // Compute period from all available data
    let start = '';
    let end = '';
    for (const p of packages) {
      for (const d of p.downloads) {
        if (!start || d.day < start) start = d.day;
        if (!end || d.day > end) end = d.day;
      }
    }

    return {
      packages,
      grandTotal,
      period: { start: start || 'N/A', end: end || 'N/A' },
      fetchedAt: this.lastPolled ?? 'never',
    };
  }

  /** Get weekly aggregates for a package (last N weeks). */
  getWeeklyTrend(pkg: string, weeks = 12): { week: string; downloads: number }[] {
    const entry = this.data.get(pkg);
    if (!entry || entry.downloads.length === 0) return [];

    // Group daily downloads into ISO weeks
    const weekMap = new Map<string, number>();
    for (const d of entry.downloads) {
      const date = new Date(d.day + 'T00:00:00Z');
      // ISO week start (Monday)
      const dayOfWeek = (date.getUTCDay() + 6) % 7; // Mon=0, Sun=6
      const monday = new Date(date.getTime() - dayOfWeek * 86_400_000);
      const weekKey = monday.toISOString().slice(0, 10);
      weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + d.downloads);
    }

    return [...weekMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-weeks)
      .map(([week, downloads]) => ({ week, downloads }));
  }

  /** Fetch downloads from npmjs.org API for all tracked packages. */
  async poll(): Promise<void> {
    const end = new Date();
    const start = new Date(end.getTime() - 90 * 86_400_000); // last 90 days
    const range = `${start.toISOString().slice(0, 10)}:${end.toISOString().slice(0, 10)}`;

    for (const pkg of TRACKED_PACKAGES) {
      try {
        const url = `https://api.npmjs.org/downloads/range/${range}/${pkg}`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const body = await res.json() as { downloads?: { day: string; downloads: number }[] };
        if (body.downloads) {
          this.record(pkg, body.downloads);
        }
      } catch {
        // npmjs.org is best-effort — don't crash on network errors
      }
    }
  }

  /** Start automatic polling on an interval. */
  startPolling(intervalMs?: number): void {
    if (intervalMs) this.pollIntervalMs = intervalMs;
    this.stopPolling();
    // Fire immediately, then on interval
    void this.poll().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.poll().catch(() => undefined);
    }, this.pollIntervalMs);
  }

  /** Stop automatic polling. */
  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get tracked package names. */
  get trackedPackages(): string[] {
    return [...TRACKED_PACKAGES];
  }

  /** Last poll timestamp (ISO string or null). */
  get lastPollTime(): string | null {
    return this.lastPolled;
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let instance: NpmMetricsStore | null = null;

export function getNpmMetricsStore(): NpmMetricsStore {
  if (!instance) instance = new NpmMetricsStore();
  return instance;
}

export function resetNpmMetricsStore(): void {
  if (instance) instance.stopPolling();
  instance = new NpmMetricsStore();
}
