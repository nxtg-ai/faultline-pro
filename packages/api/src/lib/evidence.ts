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
import { fetchOutboundFollow } from './outbound-url.js';

export const EVIDENCE_MAX_REDIRECTS = 5;

export function apiEvidenceOptions(): EvidenceOptions | undefined {
  if ((process.env.FAULTLINE_EVIDENCE_FETCH ?? '').toLowerCase() === 'off') return undefined;
  return { fetch: (url, init) => fetchOutboundFollow(url, init, EVIDENCE_MAX_REDIRECTS) };
}
