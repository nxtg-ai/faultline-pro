import { fireWebhookEvent } from './webhooks.js';

export interface ClaimVerdict {
  scanId: string;
  status: string;
  timestamp: string;
}

export interface ClaimRecord {
  normalizedText: string;
  originalText: string;
  firstSeen: string;
  lastSeen: string;
  frequency: number;
  verdicts: ClaimVerdict[];
  lastVerdict: string;
}

export interface VerdictChange {
  normalizedText: string;
  previousVerdict: string;
  currentVerdict: string;
  changedAt: string;
}

const VERIFIED_STATUSES = new Set(['supported', 'verified']);
const UNVERIFIED_STATUSES = new Set(['unverified', 'contradicted', 'mixed']);

class ClaimIndex {
  private records: Map<string, ClaimRecord> = new Map();
  private verdictChanges: VerdictChange[] = [];

  ingest(
    claims: Array<{ id: string; text: string }>,
    verifications: Record<string, { status?: string }>,
    scanId: string,
  ): void {
    const now = new Date().toISOString();

    for (const claim of claims) {
      const normalized = claim.text.trim().toLowerCase();
      const status = verifications[claim.id]?.status ?? 'unverified';

      const existing = this.records.get(normalized);

      if (!existing) {
        this.records.set(normalized, {
          normalizedText: normalized,
          originalText: claim.text,
          firstSeen: now,
          lastSeen: now,
          frequency: 1,
          verdicts: [{ scanId, status, timestamp: now }],
          lastVerdict: status,
        });
      } else {
        const previousVerdict = existing.lastVerdict;
        existing.frequency += 1;
        existing.lastSeen = now;
        existing.verdicts.push({ scanId, status, timestamp: now });
        existing.lastVerdict = status;

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

          // Fire webhook alert
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

  get size(): number {
    return this.records.size;
  }

  reset(): void {
    this.records = new Map();
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
