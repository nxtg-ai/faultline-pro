import { watch, readFileSync, existsSync, statSync, type FSWatcher } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { scan, type ScanResult } from './scan.js';
import { renderReportAs, type OutputFormat } from './report.js';

const DEFAULT_DEBOUNCE_MS = 500;

/** File extensions that watch mode will scan. */
export const WATCHED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.md']);

export interface WatchOptions {
  dir: string;
  provider?: string;
  minConfidence?: number;
  outputFormat?: OutputFormat;
  ruleNames?: string[];
  debounceMs?: number;
  /** Called with each scan result. Defaults to console.log. */
  onResult?: (file: string, output: string) => void;
  /** Called on errors. Defaults to console.error. */
  onError?: (file: string, error: string) => void;
}

export interface WatchHandle {
  close(): void;
}

/**
 * Returns true if the file has a watched extension.
 */
export function isWatchedFile(filePath: string): boolean {
  return WATCHED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Debounce tracker — prevents re-scanning the same file within the debounce window.
 * Exported for testing.
 */
export class Debouncer {
  private lastScan = new Map<string, number>();
  private debounceMs: number;

  constructor(debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    this.debounceMs = debounceMs;
  }

  /**
   * Returns true if the file should be scanned (not within debounce window).
   */
  shouldScan(filePath: string, now: number = Date.now()): boolean {
    const last = this.lastScan.get(filePath);
    if (last !== undefined && now - last < this.debounceMs) {
      return false;
    }
    return true;
  }

  /**
   * Record that a file was scanned at the given time.
   */
  record(filePath: string, now: number = Date.now()): void {
    this.lastScan.set(filePath, now);
  }

  /**
   * Get the last scan time for a file, or undefined.
   */
  getLastScan(filePath: string): number | undefined {
    return this.lastScan.get(filePath);
  }

  /**
   * Number of tracked files.
   */
  get size(): number {
    return this.lastScan.size;
  }

  /**
   * Clear all tracked files.
   */
  clear(): void {
    this.lastScan.clear();
  }
}

/**
 * Track previous findings per file to highlight new/resolved.
 * Exported for testing.
 */
export class FindingsTracker {
  private previous = new Map<string, ScanResult>();

  update(file: string, result: ScanResult): { newFindings: number; resolvedFindings: number } {
    const prev = this.previous.get(file);
    this.previous.set(file, result);

    if (!prev) {
      const totalFindings = Object.values(result.verifications)
        .filter(v => v.status === 'contradicted' || v.status === 'mixed').length
        + result.ruleFindings.length;
      return { newFindings: totalFindings, resolvedFindings: 0 };
    }

    const prevIssueIds = new Set([
      ...Object.entries(prev.verifications)
        .filter(([, v]) => v.status === 'contradicted' || v.status === 'mixed')
        .map(([id]) => id),
      ...prev.ruleFindings.map(f => f.ruleId + ':' + f.offset),
    ]);

    const currIssueIds = new Set([
      ...Object.entries(result.verifications)
        .filter(([, v]) => v.status === 'contradicted' || v.status === 'mixed')
        .map(([id]) => id),
      ...result.ruleFindings.map(f => f.ruleId + ':' + f.offset),
    ]);

    let newFindings = 0;
    for (const id of currIssueIds) {
      if (!prevIssueIds.has(id)) newFindings++;
    }

    let resolvedFindings = 0;
    for (const id of prevIssueIds) {
      if (!currIssueIds.has(id)) resolvedFindings++;
    }

    return { newFindings, resolvedFindings };
  }

  get(file: string): ScanResult | undefined {
    return this.previous.get(file);
  }

  get size(): number {
    return this.previous.size;
  }

  clear(): void {
    this.previous.clear();
  }
}

/**
 * Format watch output with clear screen and new/resolved highlights.
 */
export function formatWatchOutput(
  file: string,
  reportOutput: string,
  diff: { newFindings: number; resolvedFindings: number },
): string {
  const lines: string[] = [];
  lines.push('\x1Bc'); // clear screen escape
  lines.push(`--- ${file} ---`);

  const tags: string[] = [];
  if (diff.newFindings > 0) tags.push(`+${diff.newFindings} new`);
  if (diff.resolvedFindings > 0) tags.push(`-${diff.resolvedFindings} resolved`);
  if (tags.length > 0) {
    lines.push(`[${tags.join(', ')}]`);
  }

  lines.push(reportOutput);
  return lines.join('\n');
}

/**
 * Process a single file change event.
 * Exported for testing.
 */
export async function processFileChange(
  filePath: string,
  debouncer: Debouncer,
  options: {
    provider?: string;
    minConfidence?: number;
    outputFormat?: OutputFormat;
    ruleNames?: string[];
    onResult: (file: string, output: string) => void;
    onError: (file: string, error: string) => void;
    findingsTracker?: FindingsTracker;
  },
): Promise<boolean> {
  if (!debouncer.shouldScan(filePath)) {
    return false; // debounced
  }

  if (!existsSync(filePath)) {
    return false; // deleted
  }

  try {
    if (!statSync(filePath).isFile()) return false;
  } catch {
    return false;
  }

  const text = readFileSync(filePath, 'utf-8').trim();
  if (!text) return false;

  debouncer.record(filePath);

  try {
    const result = await scan(text, options.provider, options.minConfidence, options.ruleNames);
    const format = options.outputFormat || 'json';
    const reportOutput = renderReportAs(result, format);

    if (options.findingsTracker) {
      const diff = options.findingsTracker.update(filePath, result);
      const output = formatWatchOutput(filePath, reportOutput, diff);
      options.onResult(filePath, output);
    } else {
      options.onResult(filePath, reportOutput);
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    options.onError(filePath, msg);
    return false;
  }
}

/**
 * Start watching a directory for file changes.
 * Scans modified files incrementally with debounce.
 * Only watches supported file types (.ts, .tsx, .js, .jsx, .py, .md).
 * Gracefully shuts down on SIGINT/SIGTERM.
 */
export function startWatch(options: WatchOptions): WatchHandle {
  const dir = resolve(options.dir);
  const debouncer = new Debouncer(options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const findingsTracker = new FindingsTracker();
  const onResult = options.onResult ?? ((file, output) => console.log(output));
  const onError = options.onError ?? ((file, err) => console.error(`[error] ${file}: ${err}`));

  const watcher: FSWatcher = watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const filePath = resolve(dir, filename);

    // Skip hidden files and node_modules
    if (filename.startsWith('.') || filename.includes('node_modules')) return;

    // Only watch supported file types
    if (!isWatchedFile(filePath)) return;

    processFileChange(filePath, debouncer, {
      provider: options.provider,
      minConfidence: options.minConfidence,
      outputFormat: options.outputFormat,
      ruleNames: options.ruleNames,
      findingsTracker,
      onResult: (file, output) => onResult(relative(dir, file), output),
      onError: (file, err) => onError(relative(dir, file), err),
    });
  });

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = () => {
    watcher.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return {
    close() {
      watcher.close();
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
    },
  };
}
