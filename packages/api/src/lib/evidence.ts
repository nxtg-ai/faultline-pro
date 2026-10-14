/**
 * The evidence fetch the API gives the scan engine (GoPMO 1.18.11.3 P1b).
 *
 * Every cited source is fetched through fetchOutboundFollow, which refuses a
 * private or non-http(s) address and checks every redirect hop before it is
 * requested, so a cited link cannot bounce the server onto its own network.
 * Google's grounding links redirect once to the publisher; 5 hops is ample.
 * FAULTLINE_EVIDENCE_FETCH=off turns the fetch off without a deploy of code.
 */
import type { EvidenceOptions } from '@nxtg/faultline/evidence/passage.js';
import type { IndependentEvidenceOptions } from '@nxtg/faultline/evidence/independent.js';
import { OpenAIWebSearchRetriever } from '@nxtg/faultline/providers/openai_web_search_retriever.js';
import { fetchOutboundFollow } from './outbound-url.js';

export const EVIDENCE_MAX_REDIRECTS = 5;

export function apiEvidenceOptions(): EvidenceOptions | undefined {
  if ((process.env.FAULTLINE_EVIDENCE_FETCH ?? '').toLowerCase() === 'off') return undefined;
  return { fetch: (url, init) => fetchOutboundFollow(url, init, EVIDENCE_MAX_REDIRECTS) };
}

/**
 * The independent passage leg (GoPMO 1.18.11.3; emma-soul authorization
 * al:e615798a8e8109c0): OpenAI web_search on the claim, its result pages
 * fetched through the same guarded fetch. OFF unless FAULTLINE_PASSAGE_LEG=on
 * and an OpenAI key is set. Model: FAULTLINE_PASSAGE_SEARCH_MODEL, default
 * gpt-4o-mini (measured 2026-10-14 at about 1.1 to 1.3 cents per claim, under
 * the 1.5 cent cap).
 */
export const PASSAGE_SEARCH_DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * Models measured under the authorized 1.5 cents per checked claim. Any other
 * FAULTLINE_PASSAGE_SEARCH_MODEL value leaves the leg off rather than spend
 * past the cap (gpt-4.1-mini measured 1.4 to 1.7 cents, 2026-10-14).
 */
export const PASSAGE_SEARCH_MODELS_UNDER_CAP: readonly string[] = ['gpt-4o-mini'];

/** Deadline for the leg's search call; a stalled search must not stall the claim. */
export const PASSAGE_SEARCH_TIMEOUT_MS = 12_000;

export function apiIndependentEvidenceOptions(): IndependentEvidenceOptions | undefined {
  if ((process.env.FAULTLINE_PASSAGE_LEG ?? '').toLowerCase() !== 'on') return undefined;
  // The evidence kill switch stops every page fetch, this leg's included.
  if (apiEvidenceOptions() === undefined) return undefined;
  const key = process.env.OPENAI_API_KEY ?? '';
  if (!key) return undefined;
  const model = process.env.FAULTLINE_PASSAGE_SEARCH_MODEL || PASSAGE_SEARCH_DEFAULT_MODEL;
  if (!PASSAGE_SEARCH_MODELS_UNDER_CAP.includes(model)) return undefined;
  return {
    retriever: new OpenAIWebSearchRetriever(key, { model, timeoutMs: PASSAGE_SEARCH_TIMEOUT_MS }),
    fetch: (url, init) => fetchOutboundFollow(url, init, EVIDENCE_MAX_REDIRECTS),
    // Only a Gemini-grounded verdict lacks page passages; consensus already searches with OpenAI.
    appliesTo: (result) => result.provenance?.retriever === 'gemini-grounding',
  };
}
