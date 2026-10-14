/**
 * The audit trail of one verdict, in the shape every export carries: who
 * checked it and when (provenance), what each cited source said when it was
 * read (evidence), and the passages from the independent retriever, kept
 * apart. EP4 Amendment 2 (emma-soul al:193832a732e0b82e item 6): SARIF, the
 * guard JSON and the CSV carried verdicts with no provider, model, time or
 * fetched passage.
 *
 * Absent parts are null, never invented: a verdict whose check never ran has
 * no provenance; a source the engine did not fetch has no evidence.
 */
import type { IndependentEvidence, SourceEvidence, VerdictProvenance, VerificationResult } from '../types.js';

export interface AuditSource {
  uri: string;
  title: string | null;
  evidence: SourceEvidence | null;
}

export interface AuditTrail {
  provenance: VerdictProvenance | null;
  sources: AuditSource[];
  independentEvidence: IndependentEvidence | null;
}

export function auditTrail(v: VerificationResult | undefined): AuditTrail {
  if (!v) return { provenance: null, sources: [], independentEvidence: null };
  const sources = (Array.isArray(v.sources) ? v.sources : [])
    .filter((s) => typeof s?.uri === 'string' && s.uri.length > 0)
    .map((s) => ({ uri: s.uri, title: typeof s.title === 'string' ? s.title : null, evidence: s.evidence ?? null }));
  return {
    provenance: v.provenance ?? null,
    sources,
    independentEvidence: v.independentEvidence ?? null,
  };
}
