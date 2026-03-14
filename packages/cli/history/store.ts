import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ScanResult } from '../cli/scan.js';

export interface HistoryEntry {
  timestamp: string;
  file: string;
  provider: string;
  overallRisk: string;
  findingCount: number;
  claimCount: number;
  verificationCount: number;
  ruleFindings: Array<{ ruleId: string; severity: string; message: string }>;
  scanResult: ScanResult;
}

const DEFAULT_HISTORY_DIR = '.faultline/history';

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function generateFilename(timestamp: string, file: string): string {
  const ts = timestamp.replace(/[:.]/g, '-');
  const nonce = process.hrtime.bigint().toString();
  const hash = createHash('sha256').update(`${timestamp}-${file}-${nonce}`).digest('hex').substring(0, 8);
  return `${ts}-${hash}.json`;
}

export function saveHistoryEntry(
  scanResult: ScanResult,
  file: string,
  historyDir?: string,
): HistoryEntry {
  const dir = historyDir || DEFAULT_HISTORY_DIR;
  ensureDir(dir);

  const timestamp = new Date().toISOString();
  const entry: HistoryEntry = {
    timestamp,
    file,
    provider: scanResult.provider,
    overallRisk: scanResult.overallRisk,
    findingCount: scanResult.ruleFindings.length,
    claimCount: scanResult.claims.length,
    verificationCount: Object.keys(scanResult.verifications).length,
    ruleFindings: scanResult.ruleFindings.map(f => ({
      ruleId: f.ruleId,
      severity: f.severity,
      message: f.message,
    })),
    scanResult,
  };

  const filename = generateFilename(timestamp, file);
  writeFileSync(join(dir, filename), JSON.stringify(entry, null, 2), 'utf-8');

  return entry;
}

export function listHistory(
  historyDir?: string,
  options?: { all?: boolean },
): HistoryEntry[] {
  const dir = historyDir || DEFAULT_HISTORY_DIR;

  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const entries: HistoryEntry[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && parsed.timestamp && parsed.file && parsed.scanResult) {
        entries.push(parsed as HistoryEntry);
      }
    } catch {
      // Skip corrupt files
    }
  }

  // Sort by timestamp descending (most recent first)
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (!options?.all) {
    return entries.slice(0, 20);
  }

  return entries;
}

export interface TrendPoint {
  timestamp: string;
  findingCount: number;
  overallRisk: string;
  claimCount: number;
}

export interface TrendAnalysis {
  file: string;
  points: TrendPoint[];
  direction: 'improving' | 'degrading' | 'stable' | 'insufficient-data';
  firstScan: string | null;
  lastScan: string | null;
  findingDelta: number;
}

export function analyzeTrend(
  file: string,
  historyDir?: string,
): TrendAnalysis {
  const allEntries = listHistory(historyDir, { all: true });
  const fileEntries = allEntries
    .filter(e => e.file === file)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp)); // Chronological for trend

  if (fileEntries.length === 0) {
    return {
      file,
      points: [],
      direction: 'insufficient-data',
      firstScan: null,
      lastScan: null,
      findingDelta: 0,
    };
  }

  const points: TrendPoint[] = fileEntries.map(e => ({
    timestamp: e.timestamp,
    findingCount: e.findingCount,
    overallRisk: e.overallRisk,
    claimCount: e.claimCount,
  }));

  if (fileEntries.length < 2) {
    return {
      file,
      points,
      direction: 'insufficient-data',
      firstScan: fileEntries[0].timestamp,
      lastScan: fileEntries[0].timestamp,
      findingDelta: 0,
    };
  }

  const first = fileEntries[0];
  const last = fileEntries[fileEntries.length - 1];
  const findingDelta = last.findingCount - first.findingCount;

  let direction: TrendAnalysis['direction'];
  if (findingDelta < 0) {
    direction = 'improving';
  } else if (findingDelta > 0) {
    direction = 'degrading';
  } else {
    direction = 'stable';
  }

  return {
    file,
    points,
    direction,
    firstScan: first.timestamp,
    lastScan: last.timestamp,
    findingDelta,
  };
}

export function formatHistoryList(entries: HistoryEntry[]): string {
  if (entries.length === 0) {
    return 'No scan history found. Run `faultline scan` to create history entries.';
  }

  const lines = [`Scan History (${entries.length} entries):`, ''];
  lines.push('  Date                         File                     Findings  Risk');
  lines.push('  ' + '-'.repeat(78));

  for (const entry of entries) {
    const date = entry.timestamp.substring(0, 19).replace('T', ' ');
    const file = entry.file.length > 24 ? '...' + entry.file.slice(-21) : entry.file;
    const findings = String(entry.findingCount).padStart(3);
    const risk = entry.overallRisk.toUpperCase();
    lines.push(`  ${date.padEnd(30)} ${file.padEnd(24)} ${findings}     ${risk}`);
  }

  return lines.join('\n');
}

export function formatTrendAnalysis(trend: TrendAnalysis): string {
  if (trend.direction === 'insufficient-data' && trend.points.length === 0) {
    return `No scan history found for "${trend.file}".`;
  }

  const lines = [`Trend Analysis: ${trend.file}`, ''];

  if (trend.direction === 'insufficient-data') {
    lines.push('  Status: Insufficient data (only 1 scan)');
    lines.push(`  Last scan: ${trend.points[0].timestamp.substring(0, 19).replace('T', ' ')}`);
    lines.push(`  Findings: ${trend.points[0].findingCount}`);
    lines.push(`  Risk: ${trend.points[0].overallRisk.toUpperCase()}`);
    return lines.join('\n');
  }

  const arrow = trend.direction === 'improving' ? 'v' : trend.direction === 'degrading' ? '^' : '=';
  const label = trend.direction === 'improving' ? 'IMPROVING' : trend.direction === 'degrading' ? 'DEGRADING' : 'STABLE';

  lines.push(`  Direction: ${arrow} ${label} (${trend.findingDelta >= 0 ? '+' : ''}${trend.findingDelta} findings)`);
  lines.push(`  Scans: ${trend.points.length}`);
  lines.push(`  First: ${trend.firstScan!.substring(0, 19).replace('T', ' ')}`);
  lines.push(`  Last:  ${trend.lastScan!.substring(0, 19).replace('T', ' ')}`);
  lines.push('');
  lines.push('  Timeline:');

  for (const point of trend.points) {
    const date = point.timestamp.substring(0, 19).replace('T', ' ');
    const bar = '#'.repeat(Math.min(point.findingCount, 40));
    lines.push(`    ${date}  ${String(point.findingCount).padStart(3)} findings  ${point.overallRisk.toUpperCase().padEnd(8)}  ${bar}`);
  }

  return lines.join('\n');
}
