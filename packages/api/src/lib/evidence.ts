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

export function apiIndependentEvidenceOptions(): IndependentEvidenceOptions | undefined {
  if ((process.env.FAULTLINE_PASSAGE_LEG ?? '').toLowerCase() !== 'on') return undefined;
  const key = process.env.OPENAI_API_KEY ?? '';
  if (!key) return undefined;
  const model = process.env.FAULTLINE_PASSAGE_SEARCH_MODEL || PASSAGE_SEARCH_DEFAULT_MODEL;
  return {
    retriever: new OpenAIWebSearchRetriever(key, { model }),
    fetch: (url, init) => fetchOutboundFollow(url, init, EVIDENCE_MAX_REDIRECTS),
  };
}
