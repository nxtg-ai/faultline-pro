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
import type { Retriever } from '../providers/base_provider.js';
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
 * ran is returned as given (no search is paid for). A retriever that finds
 * nothing yields an empty `sources` list, which says so.
 */
export async function attachIndependentEvidence(
  result: VerificationResult,
  claimText: string,
  opts: IndependentEvidenceOptions,
): Promise<VerificationResult> {
  if (result.apiError === true) return result;
  if (opts.appliesTo && !opts.appliesTo(result)) return result;
  let found: Array<{ title: string; uri: string }> = [];
  try {
    found = await opts.retriever.retrieve(claimText);
  } catch {
    found = [];
  }
  const retrievedAt = new Date().toISOString();
  const picked = found.slice(0, opts.maxSources ?? 3);
  const sources = await Promise.all(picked.map(async (s) => {
    const source = { title: s.title, uri: s.uri };
    return { ...source, evidence: await fetchSourceEvidence(source, claimText, { fetch: opts.fetch, timeoutMs: opts.timeoutMs }) };
  }));
  const independentEvidence: IndependentEvidence = {
    retriever: opts.retriever.name,
    ...(typeof opts.retriever.model === 'string' ? { model: opts.retriever.model } : {}),
    retrievedAt,
    sources,
  };
  return { ...result, independentEvidence };
}
