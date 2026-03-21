/**
 * Faultline Export — converts scan history to CSV, JSON, or NDJSON.
 *
 * Data source: on-disk HistoryEntry files (.faultline/history/*.json).
 * Each entry embeds the full ScanResult (claims + verifications + rule findings).
 *
 * Formats:
 *   csv    — one row per claim per scan (exploded); full claim-level detail
 *   json   — array of flat scan summary objects
 *   ndjson — one JSON object per line per scan (streaming-friendly)
 */

import type { HistoryEntry } from '../history/store.js';
import type { Claim, VerificationResult } from '../types.js';

export type ExportFormat = 'csv' | 'json' | 'ndjson';

// ── Filter params ─────────────────────────────────────────────────────────────

export interface ExportFilter {
  from?: string;       // ISO date string (inclusive)
  to?: string;         // ISO date string (inclusive)
  provider?: string;
  risk?: string;       // 'low' | 'medium' | 'high' | 'critical'
}

export function applyFilter(entries: HistoryEntry[], filter: ExportFilter): HistoryEntry[] {
  let results = entries;
  if (filter.from)     results = results.filter(e => e.timestamp >= filter.from!);
  // Append end-of-day to an ISO date without time component so range is inclusive
  if (filter.to) {
    const toStr = filter.to.length === 10 ? filter.to + 'T23:59:59.999Z' : filter.to;
    results = results.filter(e => e.timestamp <= toStr);
  }
  if (filter.provider) results = results.filter(e => e.provider === filter.provider);
  if (filter.risk)     results = results.filter(e => e.overallRisk === filter.risk);
  return results;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  'scan_timestamp',
  'file',
  'provider',
  'overall_risk',
  'claim_id',
  'claim_text',
  'claim_type',
  'claim_importance',
  'verdict',
  'confidence',
  'explanation',
  'sources_count',
  'rule_findings_count',
  'latency_ms',
] as const;

function csvEscape(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  // RFC 4180: wrap in quotes if the value contains comma, quote, or newline
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(fields: unknown[]): string {
  return fields.map(csvEscape).join(',');
}

// ── Flat scan summary (JSON / NDJSON) ─────────────────────────────────────────

export interface ExportScanRow {
  scan_timestamp: string;
  file: string;
  provider: string;
  overall_risk: string;
  claim_count: number;
  verified_count: number;
  supported_count: number;
  contradicted_count: number;
  mixed_count: number;
  unverified_count: number;
  rule_findings_count: number;
  trust_score: number; // 0–100 derived from verdicts
}

function calcTrustScore(verifications: Record<string, VerificationResult>): number {
  const vals = Object.values(verifications);
  if (vals.length === 0) return 100;
  const weights: Record<string, number> = {
    supported: 1,
    mixed: 0.5,
    unverified: 0.3,
    skipped: 0.5,
    contradicted: 0,
    loading: 0.5,
  };
  const sum = vals.reduce((acc, v) => acc + (weights[v.status] ?? 0.5), 0);
  return Math.round((sum / vals.length) * 100);
}

function toScanRow(entry: HistoryEntry): ExportScanRow {
  const v = entry.scanResult.verifications ?? {};
  const vals = Object.values(v) as VerificationResult[];
  return {
    scan_timestamp: entry.timestamp,
    file: entry.file,
    provider: entry.provider,
    overall_risk: entry.overallRisk,
    claim_count: entry.claimCount,
    verified_count: vals.length,
    supported_count:    vals.filter(x => x.status === 'supported').length,
    contradicted_count: vals.filter(x => x.status === 'contradicted').length,
    mixed_count:        vals.filter(x => x.status === 'mixed').length,
    unverified_count:   vals.filter(x => x.status === 'unverified').length,
    rule_findings_count: entry.findingCount,
    trust_score: calcTrustScore(v),
  };
}

// ── Format renderers ──────────────────────────────────────────────────────────

export function renderCsv(entries: HistoryEntry[]): string {
  const rows: string[] = [csvRow([...CSV_HEADERS])];

  for (const entry of entries) {
    const claims: Claim[] = entry.scanResult.claims ?? [];
    const verifications: Record<string, VerificationResult> = entry.scanResult.verifications ?? {};

    if (claims.length === 0) {
      // Emit one summary row even if no claims were extracted
      rows.push(csvRow([
        entry.timestamp,
        entry.file,
        entry.provider,
        entry.overallRisk,
        '', '', '', '', '', '', '',
        0,
        entry.findingCount,
        '',
      ]));
      continue;
    }

    for (const claim of claims) {
      const vr = verifications[claim.id];
      rows.push(csvRow([
        entry.timestamp,
        entry.file,
        entry.provider,
        entry.overallRisk,
        claim.id,
        claim.text,
        claim.type,
        claim.importance,
        vr?.status ?? '',
        '',                         // confidence not in current VerificationResult schema
        vr?.explanation ?? '',
        vr?.sources?.length ?? 0,
        entry.findingCount,
        '',                         // latency not stored in CLI HistoryEntry
      ]));
    }
  }

  return rows.join('\n') + '\n';
}

export function renderJson(entries: HistoryEntry[]): string {
  return JSON.stringify(entries.map(toScanRow), null, 2) + '\n';
}

export function renderNdjson(entries: HistoryEntry[]): string {
  return entries.map(e => JSON.stringify(toScanRow(e))).join('\n') + '\n';
}

export function render(entries: HistoryEntry[], format: ExportFormat): string {
  switch (format) {
    case 'csv':    return renderCsv(entries);
    case 'ndjson': return renderNdjson(entries);
    case 'json':
    default:       return renderJson(entries);
  }
}

export function mimeType(format: ExportFormat): string {
  switch (format) {
    case 'csv':    return 'text/csv';
    case 'ndjson': return 'application/x-ndjson';
    default:       return 'application/json';
  }
}

export function fileExtension(format: ExportFormat): string {
  switch (format) {
    case 'csv':    return 'csv';
    case 'ndjson': return 'ndjson';
    default:       return 'json';
  }
}
