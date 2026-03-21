/**
 * Cache Warmup Store (D-164)
 *
 * Tracks a registry of "warmup targets" — texts (or URLs) that are
 * pre-populated into the scan cache to eliminate first-scan latency
 * for high-frequency queries.
 *
 * Design:
 *   - Admin registers targets (text or URL + provider) with an optional schedule
 *   - CacheWarmer.warmOne() calls scan() and writes the result to ScanCache
 *   - Warmup history (last 20 runs per target) is kept for observability
 *   - Admin can trigger a warmup immediately via the route layer
 *   - Global warmAll() iterates all enabled targets
 *   - Frequency tracking: most-scanned texts from ScanHistory auto-suggest targets
 */

import { randomUUID } from 'node:crypto';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getScanCache } from './cache.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WarmupProvider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';
export type WarmupStatus   = 'pending' | 'running' | 'done' | 'error';

export interface WarmupRun {
  runId:       string;
  startedAt:   string;
  completedAt: string;
  durationMs:  number;
  status:      WarmupStatus;
  cacheKey?:   string;
  error?:      string;
}

export interface WarmupTarget {
  id:          string;
  name:        string;
  text:        string;
  provider:    WarmupProvider;
  enabled:     boolean;
  priority:    number;     // lower = warmed first
  addedBy:     string;     // keyId
  addedAt:     string;
  lastWarmAt:  string | null;
  lastStatus:  WarmupStatus | null;
  runCount:    number;
  history:     WarmupRun[];
}

export interface CreateWarmupTargetInput {
  name:      string;
  text:      string;
  provider?: WarmupProvider;
  priority?: number;
  enabled?:  boolean;
}

export interface WarmupSummary {
  total:      number;
  enabled:    number;
  lastRun:    string | null;
  successCount: number;
  errorCount:   number;
}

const MAX_TARGETS  = 200;
const MAX_HISTORY  = 20;

// ── Store ─────────────────────────────────────────────────────────────────────

class WarmupStore {
  private targets = new Map<string, WarmupTarget>();

  create(input: CreateWarmupTargetInput, keyId: string): WarmupTarget {
    if (this.targets.size >= MAX_TARGETS) {
      throw new Error(`Warmup target limit reached (max ${MAX_TARGETS}).`);
    }
    const text = input.text.trim();
    if (!text) throw new Error('Warmup target text is required.');
    const name = input.name.trim();
    if (!name) throw new Error('Warmup target name is required.');

    // Deduplicate by text + provider
    const provider = input.provider ?? 'gemini';
    for (const t of this.targets.values()) {
      if (t.text === text && t.provider === provider) {
        throw new Error('A warmup target with this text and provider already exists.');
      }
    }

    const target: WarmupTarget = {
      id:         randomUUID(),
      name,
      text,
      provider,
      enabled:    input.enabled ?? true,
      priority:   input.priority ?? 100,
      addedBy:    keyId,
      addedAt:    new Date().toISOString(),
      lastWarmAt: null,
      lastStatus: null,
      runCount:   0,
      history:    [],
    };
    this.targets.set(target.id, target);
    return target;
  }

  get(id: string): WarmupTarget | undefined {
    return this.targets.get(id);
  }

  list(enabledOnly = false): WarmupTarget[] {
    const all = [...this.targets.values()].sort((a, b) => a.priority - b.priority);
    return enabledOnly ? all.filter(t => t.enabled) : all;
  }

  update(id: string, patch: Partial<Pick<WarmupTarget, 'name' | 'enabled' | 'priority' | 'provider'>>): WarmupTarget | null {
    const t = this.targets.get(id);
    if (!t) return null;
    if (patch.name     !== undefined) t.name     = patch.name.trim();
    if (patch.enabled  !== undefined) t.enabled  = patch.enabled;
    if (patch.priority !== undefined) t.priority = patch.priority;
    if (patch.provider !== undefined) t.provider = patch.provider;
    return t;
  }

  delete(id: string): boolean {
    return this.targets.delete(id);
  }

  recordRun(id: string, run: Omit<WarmupRun, 'runId'>): WarmupRun {
    const t = this.targets.get(id);
    if (!t) throw new Error('Warmup target not found.');
    const entry: WarmupRun = { runId: randomUUID(), ...run };
    t.history.unshift(entry);
    if (t.history.length > MAX_HISTORY) t.history.length = MAX_HISTORY;
    t.lastWarmAt = run.completedAt;
    t.lastStatus = run.status;
    t.runCount++;
    return entry;
  }

  getSummary(): WarmupSummary {
    const all = [...this.targets.values()];
    const runs = all.flatMap(t => t.history);
    return {
      total:        all.length,
      enabled:      all.filter(t => t.enabled).length,
      lastRun:      runs.sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0]?.completedAt ?? null,
      successCount: runs.filter(r => r.status === 'done').length,
      errorCount:   runs.filter(r => r.status === 'error').length,
    };
  }

  reset(): void {
    this.targets = new Map();
  }
}

let instance: WarmupStore | null = null;
export function getWarmupStore(): WarmupStore {
  if (!instance) instance = new WarmupStore();
  return instance;
}
export function resetWarmupStore(): void {
  instance = new WarmupStore();
}

// ── Warmer ────────────────────────────────────────────────────────────────────

export class CacheWarmer {
  /** Warm a single target. Writes result to ScanCache and records the run. */
  async warmOne(targetId: string): Promise<WarmupRun> {
    const store  = getWarmupStore();
    const target = store.get(targetId);
    if (!target) throw new Error('Warmup target not found.');

    const startedAt = new Date().toISOString();
    const start     = Date.now();

    try {
      const result = await scan(target.text, target.provider);
      getScanCache().set(target.text, target.provider, result as unknown as Record<string, unknown>);
      const durationMs  = Date.now() - start;
      return store.recordRun(targetId, {
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs,
        status:      'done',
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      return store.recordRun(targetId, {
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs,
        status: 'error',
        error:  err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Warm all enabled targets in priority order.
   * Returns per-target results; continues on individual failures.
   */
  async warmAll(): Promise<Array<{ targetId: string; name: string; run: WarmupRun }>> {
    const targets = getWarmupStore().list(true); // enabled only
    const results: Array<{ targetId: string; name: string; run: WarmupRun }> = [];
    for (const target of targets) {
      const run = await this.warmOne(target.id).catch(err => ({
        runId: randomUUID(), startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(), durationMs: 0,
        status: 'error' as WarmupStatus, error: String(err),
      }));
      results.push({ targetId: target.id, name: target.name, run });
    }
    return results;
  }
}

let warmerInstance: CacheWarmer | null = null;
export function getCacheWarmer(): CacheWarmer {
  if (!warmerInstance) warmerInstance = new CacheWarmer();
  return warmerInstance;
}
export function resetCacheWarmer(): void {
  warmerInstance = new CacheWarmer();
}
