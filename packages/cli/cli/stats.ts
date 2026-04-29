/**
 * Faultline Stats — npm download metrics for @nxtg/faultline and @nxtg/faultline-sdk.
 *
 * Fetches weekly + daily-range download counts from the public npm registry API and persists
 * snapshots to `.faultline/stats-snapshots.json` for trend analysis.
 *
 * N-214 — DIRECTIVE-NXTG-20260404-01
 * N-226 — DIRECTIVE-NXTG-20260428-01 (daily trend curve)
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Raw response from https://api.npmjs.org/downloads/point/last-week/:pkg */
export interface NpmDownloadPoint {
  downloads: number;
  start: string;
  end: string;
  package: string;
}

/** Persisted snapshot entry */
export interface NpmSnapshot {
  /** ISO date when this snapshot was recorded */
  recordedAt: string;
  /** npm package name */
  package: string;
  /** Download count for the period */
  downloads: number;
  /** Period start date (YYYY-MM-DD) */
  periodStart: string;
  /** Period end date (YYYY-MM-DD) */
  periodEnd: string;
}

export interface TrendResult {
  delta: number;
  direction: 'up' | 'down' | 'flat';
  percentChange: number;
}

export interface StatsOptions {
  packages?: string[];
  snapshotPath?: string;
  noSave?: boolean;
  /** Include 30-day daily trend sparkline (default: true) */
  dailyTrend?: boolean;
  /** Number of days for range fetch (default: 30) */
  rangeDays?: number;
}

export interface StatsResult {
  exitCode: number;
  output: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const NPM_API_BASE = 'https://api.npmjs.org/downloads/point/last-week';
const DEFAULT_SNAPSHOT_PATH = '.faultline/stats-snapshots.json';
const DEFAULT_PACKAGES = ['@nxtg/faultline', '@nxtg/faultline-sdk'];
const MAX_SNAPSHOTS = 52; // keep one year of weekly snapshots
const NPM_RANGE_BASE = 'https://api.npmjs.org/downloads/range';

// ── Daily range types ──────────────────────────────────────────────────────────

/** One day entry from npm range API */
export interface NpmDailyPoint {
  day: string;       // YYYY-MM-DD
  downloads: number;
}

/** Response from https://api.npmjs.org/downloads/range/{start}:{end}/{pkg} */
export interface NpmRangeResponse {
  start: string;
  end: string;
  package: string;
  downloads: NpmDailyPoint[];
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Fetch last-week download count for a single npm package.
 * Throws if the network request fails or the package is not found.
 */
export async function fetchNpmDownloads(pkg: string): Promise<NpmDownloadPoint> {
  const encoded = encodeURIComponent(pkg);
  const url = `${NPM_API_BASE}/${encoded}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`npm API error for "${pkg}": ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as NpmDownloadPoint;
  return data;
}

/**
 * Fetch day-by-day download counts for the last N days.
 * Uses the npm range API endpoint.
 */
export async function fetchDailyRange(pkg: string, days = 30): Promise<NpmRangeResponse> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const encoded = encodeURIComponent(pkg);
  const url = `${NPM_RANGE_BASE}/${fmt(start)}:${fmt(end)}/${encoded}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`npm range API error for "${pkg}": ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<NpmRangeResponse>;
}

/** Render a sparkline bar chart for daily downloads (ASCII, 30-char wide). */
export function renderSparkline(points: NpmDailyPoint[], width = 28): string {
  if (points.length === 0) return '(no data)';
  const vals = points.map((p) => p.downloads);
  const max = Math.max(...vals, 1);
  const bars = '▁▂▃▄▅▆▇█';
  return vals.slice(-width).map((v) => bars[Math.min(7, Math.floor((v / max) * 8))]).join('');
}

/** Load existing snapshots from disk. Returns [] if the file doesn't exist. */
export function loadSnapshots(snapshotPath: string): NpmSnapshot[] {
  if (!existsSync(snapshotPath)) return [];
  try {
    const raw = readFileSync(snapshotPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as NpmSnapshot[];
  } catch {
    return [];
  }
}

/**
 * Append a new snapshot and persist. Deduplicates by package+periodEnd so
 * re-running within the same week doesn't double-count. Keeps at most
 * MAX_SNAPSHOTS entries per package.
 */
export function saveSnapshot(snapshotPath: string, point: NpmDownloadPoint): NpmSnapshot[] {
  const existing = loadSnapshots(snapshotPath);
  const now = new Date().toISOString();

  const newSnap: NpmSnapshot = {
    recordedAt: now,
    package: point.package,
    downloads: point.downloads,
    periodStart: point.start,
    periodEnd: point.end,
  };

  // Deduplicate: replace if same package + same period end
  const filtered = existing.filter(
    (s) => !(s.package === newSnap.package && s.periodEnd === newSnap.periodEnd),
  );
  filtered.push(newSnap);

  // Keep at most MAX_SNAPSHOTS per package, sorted ascending by periodEnd
  const byPackage = new Map<string, NpmSnapshot[]>();
  for (const s of filtered) {
    if (!byPackage.has(s.package)) byPackage.set(s.package, []);
    byPackage.get(s.package)!.push(s);
  }
  const trimmed: NpmSnapshot[] = [];
  for (const snaps of byPackage.values()) {
    snaps.sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
    trimmed.push(...snaps.slice(-MAX_SNAPSHOTS));
  }

  const dir = dirname(snapshotPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(trimmed, null, 2), 'utf-8');
  return trimmed;
}

/**
 * Compute week-over-week trend for a package from its snapshot history.
 * Returns flat if fewer than 2 snapshots exist.
 */
export function computeTrend(snapshots: NpmSnapshot[], pkg: string): TrendResult {
  const pkgSnaps = snapshots
    .filter((s) => s.package === pkg)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));

  if (pkgSnaps.length < 2) {
    return { delta: 0, direction: 'flat', percentChange: 0 };
  }

  const latest = pkgSnaps[pkgSnaps.length - 1]!;
  const previous = pkgSnaps[pkgSnaps.length - 2]!;
  const delta = latest.downloads - previous.downloads;
  const percentChange = previous.downloads === 0
    ? 0
    : Math.round((delta / previous.downloads) * 100);
  const direction: TrendResult['direction'] =
    delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';

  return { delta, direction, percentChange };
}

/** Format a trend arrow + label. */
function trendLabel(t: TrendResult): string {
  if (t.direction === 'up') return `▲ +${t.delta} (+${t.percentChange}% WoW)`;
  if (t.direction === 'down') return `▼ ${t.delta} (${t.percentChange}% WoW)`;
  return '── flat (no prior data)';
}

/**
 * Render the stats output string from fetched points and snapshot history.
 */
export function renderStats(
  points: NpmDownloadPoint[],
  snapshots: NpmSnapshot[],
): string {
  const lines: string[] = [];
  lines.push('=== FAULTLINE NPM STATS ===');
  lines.push(`Period: last 7 days (${points[0]?.start ?? '?'} → ${points[0]?.end ?? '?'})`);
  lines.push('');

  const colW = 28;
  const header = `${'Package'.padEnd(colW)}  ${'Downloads'.padStart(10)}  Trend`;
  lines.push(header);
  lines.push('─'.repeat(header.length));

  for (const p of points) {
    const trend = computeTrend(snapshots, p.package);
    lines.push(
      `${p.package.padEnd(colW)}  ${String(p.downloads).padStart(10)}  ${trendLabel(trend)}`,
    );
  }

  const total = points.reduce((sum, p) => sum + p.downloads, 0);
  lines.push('─'.repeat(header.length));
  lines.push(`${'TOTAL'.padEnd(colW)}  ${String(total).padStart(10)}`);

  const snapshotCount = new Set(snapshots.map((s) => s.periodEnd)).size;
  if (snapshotCount > 0) {
    lines.push('');
    lines.push(`Snapshot history: ${snapshotCount} week(s) stored`);
  }

  return lines.join('\n');
}

// ── Command entry point ───────────────────────────────────────────────────────

/**
 * Main entry point for `faultline stats`.
 * Fetches npm download data, persists a snapshot, and returns formatted output.
 */
export async function statsCommand(opts: StatsOptions = {}): Promise<StatsResult> {
  const packages = opts.packages ?? DEFAULT_PACKAGES;
  const snapshotPath = opts.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  const includeDailyTrend = opts.dailyTrend ?? true;
  const rangeDays = opts.rangeDays ?? 30;

  const points: NpmDownloadPoint[] = [];
  const errors: string[] = [];

  for (const pkg of packages) {
    try {
      const point = await fetchNpmDownloads(pkg);
      points.push(point);
    } catch (err) {
      errors.push(`  ${pkg}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (points.length === 0) {
    return {
      exitCode: 1,
      output: `Failed to fetch npm download data:\n${errors.join('\n')}`,
    };
  }

  // Persist snapshots for successful fetches
  let snapshots: NpmSnapshot[] = [];
  if (!opts.noSave) {
    for (const point of points) {
      snapshots = saveSnapshot(snapshotPath, point);
    }
  } else {
    snapshots = loadSnapshots(snapshotPath);
  }

  let output = renderStats(points, snapshots);

  // Fetch and render daily trend curves
  if (includeDailyTrend) {
    const rangeSections: string[] = [];
    for (const pkg of packages) {
      try {
        const range = await fetchDailyRange(pkg, rangeDays);
        const spark = renderSparkline(range.downloads);
        const total = range.downloads.reduce((s, p) => s + p.downloads, 0);
        const peak = range.downloads.reduce((best, p) => p.downloads > best.downloads ? p : best, range.downloads[0] ?? { day: '?', downloads: 0 });
        rangeSections.push(
          `\n${pkg} — last ${rangeDays} days (${range.start} → ${range.end})\n` +
          `  Sparkline: ${spark}\n` +
          `  Total: ${total.toLocaleString()}  Peak: ${peak.downloads.toLocaleString()} on ${peak.day}`,
        );
      } catch {
        // Non-fatal: weekly stats already shown above
      }
    }
    if (rangeSections.length > 0) {
      output += '\n\n=== 30-DAY DAILY TREND ===' + rangeSections.join('\n');
    }
  }

  if (errors.length > 0) {
    output += `\n\nWarnings (partial data):\n${errors.join('\n')}`;
  }

  return { exitCode: 0, output };
}
