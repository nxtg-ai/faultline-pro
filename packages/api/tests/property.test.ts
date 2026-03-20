/**
 * Property-based tests — CRUCIBLE Gate 6 oracle coverage
 * Uses fast-check to exercise forensics critical paths with arbitrary inputs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  computeAttributionConfidence,
  getClaimIndex,
  resetClaimIndex,
} from '../src/store/claims.js';
import { getCostStore, resetCostStore } from '../src/store/costs.js';
import { getBulkJobStore, resetBulkJobStore } from '../src/store/bulk-jobs.js';
import type { ClaimRecord } from '../src/store/claims.js';

// ─── P1: computeAttributionConfidence always returns 0–100 ─────────────────

describe('Property-based tests — CRUCIBLE Gate 6', () => {
  it('P1. attributionConfidence is always 0–100 regardless of input shape', () => {
    fc.assert(
      fc.property(
        fc.record({
          sources: fc.array(
            fc.record({
              title: fc.string(),
              uri: fc.string(),
              scanId: fc.string(),
              seenAt: fc.string(),
            }),
            { maxLength: 20 },
          ),
          frequency: fc.nat({ max: 100 }),
          lastVerdict: fc.oneof(
            fc.constant('supported'),
            fc.constant('verified'),
            fc.constant('unverified'),
            fc.constant('contradicted'),
            fc.constant('mixed'),
            fc.string(),
          ),
          claimType: fc.oneof(
            fc.constant('fact'),
            fc.constant('opinion'),
            fc.constant('interpretation'),
            fc.string(),
          ),
        }),
        (partial) => {
          const record: ClaimRecord = {
            id: 'test-id',
            normalizedText: 'test',
            originalText: 'test',
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            verdicts: [],
            ...partial,
          };
          const score = computeAttributionConfidence(record);
          return score >= 0 && score <= 100;
        },
      ),
    );
  });

  // ─── P2: search() results are a subset of all ingested claims ──────────────

  it('P2. search() results are always a subset of all ingested claims', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 5, maxLength: 50 }), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (claimTexts, searchTerm) => {
          resetClaimIndex();
          const index = getClaimIndex();
          const claims = claimTexts.map((text, i) => ({
            id: `c${i}`,
            text,
            type: 'fact',
          }));
          index.ingest(claims, {}, 'scan-1');
          const all = index.search({});
          const filtered = index.search({ text: searchTerm });
          // filtered must be a subset of all
          return filtered.every((r) => all.some((a) => a.id === r.id));
        },
      ),
    );
  });

  // ─── P3: ingest() deduplicates by normalized text ──────────────────────────

  it('P3. ingest() deduplicates by normalized text — same text twice → frequency 2', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 5, maxLength: 100 }),
        (text) => {
          resetClaimIndex();
          const index = getClaimIndex();
          const claim = [{ id: 'c1', text, type: 'fact' }];
          index.ingest(claim, {}, 'scan-1');
          index.ingest(claim, {}, 'scan-2');
          const results = index.getTrending(10);
          // Should have exactly 1 record (deduplicated) with frequency 2
          return results.length === 1 && results[0].frequency === 2;
        },
      ),
    );
  });

  // ─── P4: CostStore aggregate totalCostUsd equals sum of individual costs ───

  it('P4. aggregate totalCostUsd equals sum of all individual scan costs', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            keyId: fc.string({ minLength: 1, maxLength: 20 }),
            provider: fc.constantFrom(
              'gemini',
              'openai',
              'claude',
              'perplexity',
              'mock',
            ),
            text: fc.string({ minLength: 1, maxLength: 1000 }),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        (scans) => {
          resetCostStore();
          const store = getCostStore();
          for (const s of scans) store.record(s.keyId, s.provider, s.text);
          const all = store.getCosts();
          const agg = store.getAggregate();
          const manualTotal = all.reduce(
            (sum, c) => sum + c.estimatedCostUsd,
            0,
          );
          // Allow floating point epsilon
          return Math.abs(agg.totalCostUsd - manualTotal) < 0.0001;
        },
      ),
    );
  });

  // ─── P5: CostStore aggregate totalTokens equals sum of individual tokens ───

  it('P5. aggregate totalTokens equals sum of all individual token counts', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            keyId: fc.string({ minLength: 1, maxLength: 20 }),
            provider: fc.constantFrom(
              'gemini',
              'openai',
              'claude',
              'perplexity',
              'mock',
            ),
            text: fc.string({ minLength: 1, maxLength: 500 }),
          }),
          { minLength: 1, maxLength: 15 },
        ),
        (scans) => {
          resetCostStore();
          const store = getCostStore();
          for (const s of scans) store.record(s.keyId, s.provider, s.text);
          const all = store.getCosts();
          const agg = store.getAggregate();
          const manualTokens = all.reduce(
            (sum, c) => sum + c.estimatedTokens,
            0,
          );
          return agg.totalTokens === manualTokens;
        },
      ),
    );
  });

  // ─── P6: BulkJobStore progressPercent is always 0–100 ─────────────────────

  it('P6. progressPercent is always in range [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 20 }),
        fc.nat({ max: 20 }),
        (totalFiles, extraResults) => {
          resetBulkJobStore();
          const store = getBulkJobStore();
          if (totalFiles === 0) return true; // skip degenerate case
          const job = store.create(totalFiles);
          const resultCount = Math.min(extraResults, totalFiles);
          for (let i = 0; i < resultCount; i++) {
            store.recordFileResult(job.id, {
              filename: `f${i}.txt`,
              status: 'done',
              overallRisk: 'low',
            });
          }
          const updated = store.get(job.id)!;
          return updated.progressPercent >= 0 && updated.progressPercent <= 100;
        },
      ),
    );
  });

  // ─── P7: search() limit is always respected ────────────────────────────────

  it('P7. search() never returns more than limit results', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 5 }),
        (numClaims, limit) => {
          resetClaimIndex();
          const index = getClaimIndex();
          const claims = Array.from({ length: numClaims }, (_, i) => ({
            id: `c${i}`,
            text: `unique claim text number ${i} for property test`,
            type: 'fact',
          }));
          index.ingest(claims, {}, 'scan-x');
          const results = index.search({ limit });
          return results.length <= limit;
        },
      ),
    );
  });

  // ─── P8: adding sources never decreases attribution confidence ─────────────

  it('P8. adding a source never decreases attribution confidence', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5 }),
        (extraSources) => {
          const base: ClaimRecord = {
            id: 'x',
            normalizedText: 'x',
            originalText: 'x',
            claimType: 'fact',
            firstSeen: '',
            lastSeen: '',
            frequency: 1,
            verdicts: [],
            lastVerdict: 'unverified',
            sources: [],
          };
          const withSources: ClaimRecord = {
            ...base,
            sources: Array.from({ length: extraSources }, (_, i) => ({
              title: `src${i}`,
              uri: `https://example.com/${i}`,
              scanId: 'sc',
              seenAt: '',
            })),
          };
          return (
            computeAttributionConfidence(withSources) >=
            computeAttributionConfidence(base)
          );
        },
      ),
    );
  });

  // ─── P9: getCosts({ provider }) returns only matching provider entries ──────

  it('P9. getCosts({ provider }) returns only entries for that provider', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            'gemini',
            'openai',
            'claude',
            'perplexity',
            'mock',
          ) as fc.Arbitrary<string>,
          { minLength: 1, maxLength: 10 },
        ),
        fc.constantFrom(
          'gemini',
          'openai',
          'claude',
          'perplexity',
          'mock',
        ) as fc.Arbitrary<string>,
        (providers, filterProvider) => {
          resetCostStore();
          const store = getCostStore();
          providers.forEach((p, i) =>
            store.record(`key-${i}`, p, 'test text'),
          );
          const filtered = store.getCosts({ provider: filterProvider });
          return filtered.every((c) => c.provider === filterProvider);
        },
      ),
    );
  });

  // ─── P10: getTrending() is sorted by frequency descending ──────────────────

  it('P10. getTrending() always returns claims sorted by frequency descending', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            text: fc.string({ minLength: 10, maxLength: 60 }),
            scanCount: fc.nat({ max: 5 }),
          }),
          { minLength: 2, maxLength: 8 },
        ),
        (items) => {
          resetClaimIndex();
          const index = getClaimIndex();
          items.forEach(({ text, scanCount }, i) => {
            const claim = [
              {
                id: `c${i}`,
                text: text + i, // ensure unique texts
                type: 'fact',
              },
            ];
            for (let s = 0; s <= scanCount; s++) {
              index.ingest(claim, {}, `scan-${i}-${s}`);
            }
          });
          const trending = index.getTrending(100);
          for (let i = 1; i < trending.length; i++) {
            if (trending[i].frequency > trending[i - 1].frequency) return false;
          }
          return true;
        },
      ),
    );
  });
});
