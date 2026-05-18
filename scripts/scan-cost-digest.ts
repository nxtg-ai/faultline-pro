#!/usr/bin/env tsx
/**
 * scan-cost-digest — DIRECTIVE-NXTG-20260518-02 daily roll-up.
 *
 * Reads /var/log/faultline/scan-cost.jsonl (NDJSON, one row per scan),
 * computes p50/p90/p99 cost_usd by user_tier, writes digest to
 * .asif/scan-cost-digest.json. Designed to run as a daily cron job on Fly.
 *
 * Usage:
 *   tsx scripts/scan-cost-digest.ts [--log /path/to/scan-cost.jsonl]
 *   node --import=tsx/esm scripts/scan-cost-digest.ts
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LOG = '/var/log/faultline/scan-cost.jsonl';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DIGEST_PATH = join(__dirname, '../.asif/scan-cost-digest.json');

interface LogRow {
  ts: string;
  scan_id: string;
  user_tier: string;
  provider: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  tool_call_count: number;
  wall_ms: number;
  usd_estimate: number;
  cache_hit: boolean;
}

interface TierStats {
  p50: number;
  p90: number;
  p99: number;
  count: number;
  total_usd: number;
  avg_wall_ms: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const logIdx = args.indexOf('--log');
  const logPath = logIdx !== -1 && args[logIdx + 1] ? args[logIdx + 1]! : DEFAULT_LOG;

  let raw: string;
  try {
    raw = await readFile(logPath, 'utf8');
  } catch {
    console.error(`[scan-cost-digest] Log not found at ${logPath} — writing empty digest.`);
    await writeFile(DIGEST_PATH, JSON.stringify({ generated_at: new Date().toISOString(), log_path: logPath, tiers: {}, total_scans: 0 }, null, 2));
    return;
  }

  const rows: LogRow[] = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) as LogRow; }
      catch { return null; }
    })
    .filter((r): r is LogRow => r !== null);

  const byTier = new Map<string, number[]>();
  const wallByTier = new Map<string, number[]>();

  for (const row of rows) {
    const tier = row.user_tier ?? 'unknown';
    if (!byTier.has(tier)) { byTier.set(tier, []); wallByTier.set(tier, []); }
    byTier.get(tier)!.push(row.usd_estimate ?? 0);
    wallByTier.get(tier)!.push(row.wall_ms ?? 0);
  }

  const tiers: Record<string, TierStats> = {};
  for (const [tier, costs] of byTier) {
    const sorted = [...costs].sort((a, b) => a - b);
    const walls = wallByTier.get(tier) ?? [];
    tiers[tier] = {
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p99: percentile(sorted, 99),
      count: sorted.length,
      total_usd: sorted.reduce((s, v) => s + v, 0),
      avg_wall_ms: walls.length ? walls.reduce((s, v) => s + v, 0) / walls.length : 0,
    };
  }

  const digest = {
    generated_at: new Date().toISOString(),
    log_path: logPath,
    total_scans: rows.length,
    tiers,
  };

  await writeFile(DIGEST_PATH, JSON.stringify(digest, null, 2));
  console.log(`[scan-cost-digest] Written ${rows.length} scans → ${DIGEST_PATH}`);
  for (const [tier, stats] of Object.entries(tiers)) {
    console.log(`  ${tier}: p50=$${stats.p50.toFixed(6)} p90=$${stats.p90.toFixed(6)} p99=$${stats.p99.toFixed(6)} (n=${stats.count})`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
