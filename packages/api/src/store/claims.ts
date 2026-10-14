import { storedVerdictProblem, InvalidVerdictError } from '@nxtg/faultline/lib/verdict-guard.js';
import { randomUUID } from 'node:crypto';
import { fireWebhookEvent } from './webhooks.js';
import { isGroundedVerification } from './cache.js';

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

/**
 * The claim index is kept per caller (the same identity as the scan cache and
 * webhooks: API key plus, behind faultline-web's server key, the user). A
 * caller reads only its own claims; a null caller (the server key without a
 * user ref) indexes and reads nothing. Gemini Grounded Results never enter it,
 * not even the caller's own: Google's terms forbid caching or storing them
 * (emma-soul al:1fba541b5d8c468f; same rule as the scan cache, item 7).
 */
class ClaimIndex {
  /** Keyed by `${caller}\0${normalizedText}`. */
  private records: Map<string, ClaimRecord> = new Map();
  private byId: Map<string, ClaimRecord> = new Map();
  private callerById: Map<string, string> = new Map();
  private verdictChanges: Array<{ caller: string; change: VerdictChange }> = [];

  /** The caller's own records. */
  private recordsOf(caller: string | null): ClaimRecord[] {
    if (caller === null) return [];
    return [...this.byId.values()].filter((r) => this.callerById.get(r.id) === caller);
  }

  ingest(
    claims: Array<{ id: string; text: string; type?: string }>,
    verifications: Record<string, { status?: string; sources?: Array<{ title: string; uri: string }>; provenance?: { retrievedAt?: string } }>,
    scanId: string,
    caller: string | null,
    provider?: string,
  ): void {
    for (const claim of claims) {
      const v = verifications[claim.id];
      // A missing status reads as 'unverified' below, so it is checked as that.
      const problem = v === undefined ? null : storedVerdictProblem({ ...v, status: v.status ?? 'unverified' });
      if (problem !== null) {
        throw new InvalidVerdictError(`claim ${claim.id}: ${problem}`);
      }
    }
    if (caller === null || provider === 'gemini') return;
    const now = new Date().toISOString();

    for (const claim of claims) {
      if (isGroundedVerification(verifications[claim.id])) continue;
      const normalized = claim.text.trim().toLowerCase();
      const key = `${caller}\u0000${normalized}`;
      const status = verifications[claim.id]?.status ?? 'unverified';
      const rawSources = verifications[claim.id]?.sources ?? [];
      const claimType = claim.type ?? 'fact';

      // seenAt is when the evidence was retrieved when the verdict says so, else
      // when it was indexed (GoPMO 1.18.11.3 P1a; EP4 recert row 2).
      const retrievedAt = verifications[claim.id]?.provenance?.retrievedAt;
      const seenAt = typeof retrievedAt === 'string' && !Number.isNaN(Date.parse(retrievedAt)) ? retrievedAt : now;
      const newSources: ClaimSource[] = rawSources.map((s) => ({
        title: s.title,
        uri: s.uri,
        scanId,
        seenAt,
      }));

      const existing = this.records.get(key);

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
        this.records.set(key, record);
        this.byId.set(record.id, record);
        this.callerById.set(record.id, caller);
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
          this.verdictChanges.push({ caller, change });
          fireWebhookEvent('claim.verdict_changed', {
            claim: existing.originalText,
            previousVerdict,
            currentVerdict: status,
            changedAt: now,
          }, null);
        }
      }
    }
  }

  /** The record, only when it belongs to `caller`. */
  getById(id: string, caller: string | null): ClaimRecord | undefined {
    if (caller === null || this.callerById.get(id) !== caller) return undefined;
    return this.byId.get(id);
  }

  explain(id: string, caller: string | null): {
    claim: string;
    claimType: string;
    verdict: string;
    confidence: number;
    reasoningChain: string[];
    evidenceFound: Array<{ title: string; uri: string; seenAt: string }>;
    suggestions: string[];
  } | null {
    const record = this.getById(id, caller);
    if (!record) return null;

    const confidence = computeAttributionConfidence(record);

    const reasoningChain: string[] = [
      `Claim text: "${record.originalText.slice(0, 120)}"`,
      `Current verdict: ${record.lastVerdict}`,
      `Seen in ${record.frequency} scan(s) — first seen ${record.firstSeen}`,
      record.sources.length > 0
        ? `Found ${record.sources.length} supporting source(s)`
        : 'No supporting sources found in any scan',
      `Attribution confidence: ${confidence}/100`,
    ];

    const evidenceFound = record.sources.map((s) => ({
      title: s.title,
      uri: s.uri,
      seenAt: s.seenAt,
    }));

    let suggestions: string[];

    if (confidence >= 60) {
      suggestions = ['Claim is well-supported — no action required'];
    } else {
      suggestions = [];
      if (confidence < 40) {
        suggestions.push('Add a specific source URL that supports this claim');
      }
      if (record.sources.length < 3) {
        suggestions.push('Citing 3 or more sources increases confidence by 20 points');
      }
      if (record.frequency < 3) {
        suggestions.push(
          `This claim has only been seen ${record.frequency} time(s); re-scan after revisions to build a verdict history`,
        );
      }
      if (UNVERIFIED_STATUSES.has(record.lastVerdict)) {
        suggestions.push(
          'Rephrase the claim to be more specific and falsifiable — vague claims are harder to verify',
        );
      }
      if (record.claimType !== 'fact') {
        suggestions.push(
          'Converting opinion/interpretation claims to factual assertions improves verifiability',
        );
      }
      suggestions.push('Provide a date range or publication year for time-sensitive claims');
    }

    return {
      claim: record.originalText,
      claimType: record.claimType,
      verdict: record.lastVerdict,
      confidence,
      reasoningChain,
      evidenceFound,
      suggestions,
    };
  }

  /**
   * Top N claims by frequency.
   */
  getTrending(caller: string | null, limit = 10): ClaimRecord[] {
    return this.recordsOf(caller)
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, limit);
  }

  /**
   * Claims first seen within the last `windowMs` milliseconds (default 24h).
   */
  getEmerging(caller: string | null, limit = 10, windowMs = 24 * 60 * 60 * 1000): ClaimRecord[] {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    return this.recordsOf(caller)
      .filter((r) => r.firstSeen >= cutoff)
      .sort((a, b) => b.firstSeen.localeCompare(a.firstSeen))
      .slice(0, limit);
  }

  /**
   * Claims that flipped from verified to unverified.
   */
  getVerdictChanges(caller: string | null, limit = 10): VerdictChange[] {
    if (caller === null) return [];
    return this.verdictChanges.filter((c) => c.caller === caller).map((c) => c.change).slice(-limit);
  }

  search(caller: string | null, params: {
    text?: string;
    verdict?: string;
    from?: string;
    to?: string;
    source?: string;
    limit?: number;
  }): ClaimRecord[] {
    let results = this.recordsOf(caller);
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

  /**
   * Aggregate stats across the caller's indexed claims.
   * accuracyRate = supported / (supported + contradicted)  — "of claims with a definitive verdict, how many checked out?"
   * verifiedRate = supported / total  — "what fraction of all AI claims were accurate?"
   */
  getStats(caller: string | null): {
    totalClaims:    number;
    totalScans:     number;
    byVerdict:      Record<string, number>;
    accuracyRate:   number;   // supported / (supported + contradicted)
    verifiedRate:   number;   // supported / total
    claimTypes:     Record<string, number>;
    avgFrequency:   number;
    topSources:     Array<{ uri: string; count: number }>;
  } {
    const all = this.recordsOf(caller);
    const byVerdict: Record<string, number> = {};
    const claimTypes: Record<string, number> = {};
    const sourceMap: Map<string, number> = new Map();
    const scanIds = new Set<string>();
    let freqSum = 0;

    for (const r of all) {
      byVerdict[r.lastVerdict] = (byVerdict[r.lastVerdict] ?? 0) + 1;
      claimTypes[r.claimType]  = (claimTypes[r.claimType]  ?? 0) + 1;
      freqSum += r.frequency;
      for (const v of r.verdicts) scanIds.add(v.scanId);
      for (const s of r.sources) {
        const host = (() => { try { return new URL(s.uri).hostname; } catch { return s.uri; } })();
        sourceMap.set(host, (sourceMap.get(host) ?? 0) + 1);
      }
    }

    const supported    = byVerdict['supported']    ?? 0;
    const contradicted = byVerdict['contradicted'] ?? 0;
    const definitive   = supported + contradicted;

    const topSources = [...sourceMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([uri, count]) => ({ uri, count }));

    return {
      totalClaims:  all.length,
      totalScans:   scanIds.size,
      byVerdict,
      accuracyRate: definitive > 0 ? supported / definitive : 0,
      verifiedRate: all.length   > 0 ? supported / all.length : 0,
      claimTypes,
      avgFrequency: all.length   > 0 ? freqSum / all.length : 0,
      topSources,
    };
  }

  get size(): number {
    return this.records.size;
  }

  reset(): void {
    this.records = new Map();
    this.byId = new Map();
    this.callerById = new Map();
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
