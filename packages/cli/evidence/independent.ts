/**
 * The independent passage leg (GoPMO 1.18.11.3; emma-soul authorization
 * al:e615798a8e8109c0).
 *
 * Gemini grounding Links may not be followed (provider terms), so a verdict
 * grounded on Gemini carries no page passage. This leg runs a second
 * retriever whose terms allow it (OpenAI web_search: the customer "owns all
 * Output", OpenAI Services Agreement §4.1) on the same claim, fetches that
 * retriever's own result pages through the caller's guarded fetch, and
 * quotes the best-matching passage from each page. The result is kept in its
 * own field, labelled with its retriever, model and time, and never merged
 * into the verdict's sources.
 */
import type { RetrievalOutcome, Retriever } from '../providers/base_provider.js';
import type { IndependentEvidence, VerificationResult } from '../types.js';
import { fetchSourceEvidence, type EvidenceFetch } from './passage.js';

export interface IndependentEvidenceOptions {
  retriever: Retriever & { readonly model?: string };
  /** The guarded fetch used for the retriever's result pages. */
  fetch: EvidenceFetch;
  /** Result pages fetched per claim at most (default 3). */
  maxSources?: number;
  timeoutMs?: number;
  /** Run the leg only for verdicts this accepts (the API: Gemini-grounded verdicts only). Absent: every verdict. */
  appliesTo?: (result: VerificationResult) => boolean;
}

/**
 * The verdict with `independentEvidence` attached. A verdict whose check never
 * ran is returned as given (no search is paid for). `status` says how the
 * search ended, so an empty `sources` list reads as "nothing found" only when
 * the status is `zero`, never when the search failed.
 */
export async function attachIndependentEvidence(
  result: VerificationResult,
  claimText: string,
  opts: IndependentEvidenceOptions,
): Promise<VerificationResult> {
  if (result.apiError === true) return result;
  if (opts.appliesTo && !opts.appliesTo(result)) return result;
  const outcome = await searchWithStatus(opts.retriever, claimText);
  const retrievedAt = new Date().toISOString();
  const picked = outcome.sources.slice(0, opts.maxSources ?? 3);
  const sources = await Promise.all(picked.map(async (s) => {
    const source = { title: s.title, uri: s.uri };
    return { ...source, evidence: await fetchSourceEvidence(source, claimText, { fetch: opts.fetch, timeoutMs: opts.timeoutMs }) };
  }));
  const independentEvidence: IndependentEvidence = {
    retriever: opts.retriever.name,
    ...(typeof opts.retriever.model === 'string' ? { model: opts.retriever.model } : {}),
    retrievedAt,
    status: outcome.status,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    sources,
  };
  return { ...result, independentEvidence };
}

/**
 * The retriever's own status when it reports one. Otherwise read from
 * retrieve(): a throw is provider_error, [] is zero, anything else is hits.
 */
async function searchWithStatus(retriever: Retriever, claimText: string): Promise<RetrievalOutcome> {
  try {
    if (typeof retriever.retrieveWithStatus === 'function') {
      const outcome = await retriever.retrieveWithStatus(claimText);
      // Pages are fetched only for hits, so a failed search never pays for a fetch.
      return { ...outcome, sources: outcome.status === 'hits' ? outcome.sources : [] };
    }
    const found = await retriever.retrieve(claimText);
    return Array.isArray(found) && found.length > 0 ? { status: 'hits', sources: found } : { status: 'zero', sources: [] };
  } catch {
    return { status: 'provider_error', sources: [], detail: 'request failed' };
  }
}
