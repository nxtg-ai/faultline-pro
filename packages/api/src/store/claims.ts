import { randomUUID } from 'node:crypto';
import { fireWebhookEvent } from './webhooks.js';

export interface ClaimVerdict {
  scanId: string;
  status: string;
  timestamp: string;
}

export interface ClaimSource {
  title: string;
  uri: string;
  scanId: string;
  seenAt: string;
}

export interface ClaimRecord {
  id: string;
  normalizedText: string;
  originalText: string;
  claimType: string;
  firstSeen: string;
  lastSeen: string;
  frequency: number;
  verdicts: ClaimVerdict[];
  lastVerdict: string;
  sources: ClaimSource[];
}

export interface VerdictChange {
  normalizedText: string;
  previousVerdict: string;
  currentVerdict: string;
  changedAt: string;
}

const VERIFIED_STATUSES = new Set(['supported', 'verified']);
const UNVERIFIED_STATUSES = new Set(['unverified', 'contradicted', 'mixed']);

/**
 * Attribution confidence 0–100.
 * +40 has any source, +20 has 3+ sources, +20 seen in 3+ scans,
 * +10 currently verified, +10 claim type is 'fact'.
 */
export function computeAttributionConfidence(record: ClaimRecord): number {
  let score = 0;
  if (record.sources.length > 0) score += 40;
  if (record.sources.length >= 3) score += 20;
  if (record.frequency >= 3) score += 20;
  if (VERIFIED_STATUSES.has(record.lastVerdict)) score += 10;
  if (record.claimType === 'fact') score += 10;
  return Math.min(100, score);
}

class ClaimIndex {
  private records: Map<string, ClaimRecord> = new Map();
  private byId: Map<string, ClaimRecord> = new Map();
  private verdictChanges: VerdictChange[] = [];

  ingest(
    claims: Array<{ id: string; text: string; type?: string }>,
    verifications: Record<string, { status?: string; sources?: Array<{ title: string; uri: string }> }>,
    scanId: string,
  ): void {
    const now = new Date().toISOString();

    for (const claim of claims) {
      const normalized = claim.text.trim().toLowerCase();
      const status = verifications[claim.id]?.status ?? 'unverified';
      const rawSources = verifications[claim.id]?.sources ?? [];
      const claimType = claim.type ?? 'fact';

      const newSources: ClaimSource[] = rawSources.map((s) => ({
        title: s.title,
        uri: s.uri,
        scanId,
        seenAt: now,
      }));

      const existing = this.records.get(normalized);

      if (!existing) {
        const record: ClaimRecord = {
          id: randomUUID(),
          normalizedText: normalized,
          originalText: claim.text,
          claimType,
          firstSeen: now,
          lastSeen: now,
          frequency: 1,
          verdicts: [{ scanId, status, timestamp: now }],
          lastVerdict: status,
          sources: newSources,
        };
        this.records.set(normalized, record);
        this.byId.set(record.id, record);
      } else {
        const previousVerdict = existing.lastVerdict;
        existing.frequency += 1;
        existing.lastSeen = now;
        existing.verdicts.push({ scanId, status, timestamp: now });
        existing.lastVerdict = status;
        // Merge new sources (deduplicate by uri)
        const existingUris = new Set(existing.sources.map((s) => s.uri));
        for (const s of newSources) {
          if (!existingUris.has(s.uri)) {
            existing.sources.push(s);
            existingUris.add(s.uri);
          }
        }

        // Detect verified → unverified flip
        if (
          VERIFIED_STATUSES.has(previousVerdict) &&
          UNVERIFIED_STATUSES.has(status)
        ) {
          const change: VerdictChange = {
            normalizedText: normalized,
            previousVerdict,
            currentVerdict: status,
            changedAt: now,
          };
          this.verdictChanges.push(change);
          fireWebhookEvent('claim.verdict_changed', {
            claim: existing.originalText,
            previousVerdict,
            currentVerdict: status,
            changedAt: now,
          });
        }
      }
    }
  }

  getById(id: string): ClaimRecord | undefined {
    return this.byId.get(id);
  }

  /**
   * Top N claims by frequency.
   */
  getTrending(limit = 10): ClaimRecord[] {
    return [...this.records.values()]
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, limit);
  }

  /**
   * Claims first seen within the last `windowMs` milliseconds (default 24h).
   */
  getEmerging(limit = 10, windowMs = 24 * 60 * 60 * 1000): ClaimRecord[] {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    return [...this.records.values()]
      .filter((r) => r.firstSeen >= cutoff)
      .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
      .slice(0, limit);
  }

  /**
   * Claims that flipped from verified to unverified.
   */
  getVerdictChanges(limit = 10): VerdictChange[] {
    return this.verdictChanges.slice(-limit);
  }

  search(params: {
    text?: string;
    verdict?: string;
    from?: string;
    to?: string;
    source?: string;
    limit?: number;
  }): ClaimRecord[] {
    let results = [...this.records.values()];
    if (params.text) {
      const q = params.text.toLowerCase();
      results = results.filter((r) => r.normalizedText.includes(q));
    }
    if (params.verdict) {
      results = results.filter((r) => r.lastVerdict === params.verdict);
    }
    if (params.from) {
      results = results.filter((r) => r.firstSeen >= params.from!);
    }
    if (params.to) {
      results = results.filter((r) => r.firstSeen <= params.to!);
    }
    if (params.source) {
      const s = params.source.toLowerCase();
      results = results.filter((r) =>
        r.sources.some((src) => src.uri.toLowerCase().includes(s) || src.title.toLowerCase().includes(s))
      );
    }
    return results
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, params.limit ?? 50);
  }

  get size(): number {
    return this.records.size;
  }

  reset(): void {
    this.records = new Map();
    this.byId = new Map();
    this.verdictChanges = [];
  }
}

let instance: ClaimIndex | null = null;

export function getClaimIndex(): ClaimIndex {
  if (!instance) instance = new ClaimIndex();
  return instance;
}

export function resetClaimIndex(): void {
  instance = new ClaimIndex();
}
