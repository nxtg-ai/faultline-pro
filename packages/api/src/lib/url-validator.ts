import { fetchOutbound } from './outbound-url.js';
import { EVIDENCE_USER_AGENT, robotsVerdict } from '@nxtg/faultline/evidence/robots.js';
import { isGroundingRedirect } from '@nxtg/faultline/evidence/grounding.js';

export interface SourceValidation {
  uri: string;
  title: string;
  available: boolean;
  statusCode: number;
  lastModified?: string;
  evidenceScore: number; // 0–100
  /**
   * Why the source was deliberately not probed: provider_terms, a Google
   * grounding Link (the terms forbid "using Links to identify destination
   * pages for crawling or scraping"); robots, the site's robots.txt disallows
   * FaultlineEvidence for it or a redirect hop.
   */
  notChecked?: 'provider_terms' | 'robots';
}

export interface EvidenceLink {
  claimId: string;
  sources: SourceValidation[];
  overallEvidenceScore: number; // 0–100, average of source scores
}

// Injectable fetcher — default runs through the outbound URL guard, can be swapped in tests
type FetchResult = { status: number; headers: Record<string, string>; notChecked?: 'provider_terms' | 'robots' };
type FetchFn = (uri: string) => Promise<FetchResult>;

/** Redirect hops followed when probing a source; each hop is guarded before it is requested. */
const MAX_SOURCE_REDIRECTS = 3;

/**
 * HEAD-probe a source URI that a model returned. The URI is untrusted, so every
 * request goes through the outbound URL guard (connect-time-checked undici, no
 * automatic redirects); redirects are followed here, at most
 * MAX_SOURCE_REDIRECTS hops. Before each hop: a Google grounding Link is never
 * requested (provider terms), and the site's robots.txt is asked, as for every
 * evidence fetch (emma-soul al:15b443bc1ccf7a4e). Every failure, a blocked
 * target included, reports the source as unreachable (status 0) and never
 * throws, so a hostile source cannot turn a scan into a 500.
 */
const defaultFetcher: FetchFn = async (uri: string) => {
  const signal = AbortSignal.timeout(5000);
  let current = uri;
  try {
    for (let hop = 0; ; hop++) {
      if (isGroundingRedirect(current)) return { status: 0, headers: {}, notChecked: 'provider_terms' };
      const robots = await robotsVerdict(current, (u, init) => fetchOutbound(u, init), { signal });
      if (robots === 'disallow') return { status: 0, headers: {}, notChecked: 'robots' };
      if (robots === 'unreachable') return { status: 0, headers: {} };
      const res = await fetchOutbound(current, { method: 'HEAD', signal, headers: { 'user-agent': EVIDENCE_USER_AGENT } });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        void res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_SOURCE_REDIRECTS) return { status: 0, headers: {} };
        current = new URL(location, current).toString();
        continue;
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { status: res.status, headers };
    }
  } catch {
    return { status: 0, headers: {} };
  }
};

let _fetcher: FetchFn = defaultFetcher;

export function setUrlFetcher(fn: FetchFn): void {
  _fetcher = fn;
}

export function resetUrlFetcher(): void {
  _fetcher = defaultFetcher;
}

function scoreSource(
  result: { status: number; headers: Record<string, string> },
  title: string,
  claimText: string,
): number {
  let score = 0;

  // +50 for source availability (2xx)
  if (result.status >= 200 && result.status < 300) {
    score += 50;
  } else if (result.status >= 300 && result.status < 400) {
    // Redirect still implies existence
    score += 30;
  }

  // +30 for title relevance — check if claim keywords appear in title
  const claimWords = claimText
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 4);
  const titleLower = title.toLowerCase();
  const matchCount = claimWords.filter((w) => titleLower.includes(w)).length;
  if (claimWords.length > 0) {
    score += Math.round((matchCount / claimWords.length) * 30);
  }

  // +20 for recency — Last-Modified within 2 years
  const lastModified = result.headers['last-modified'];
  if (lastModified) {
    const modDate = new Date(lastModified);
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    if (!isNaN(modDate.getTime()) && modDate > twoYearsAgo) {
      score += 20;
    }
  }

  return Math.min(100, score);
}

export async function validateSourceUrl(
  uri: string,
  title: string,
  claimText: string,
): Promise<SourceValidation> {
  // A Google grounding Link is never requested, whichever fetcher is installed.
  const result: FetchResult = isGroundingRedirect(uri)
    ? { status: 0, headers: {}, notChecked: 'provider_terms' }
    : await _fetcher(uri);
  const available = result.status >= 200 && result.status < 400;
  const evidenceScore = scoreSource(result, title, claimText);

  return {
    uri,
    title,
    available,
    statusCode: result.status,
    lastModified: result.headers['last-modified'],
    evidenceScore,
    ...(result.notChecked ? { notChecked: result.notChecked } : {}),
  };
}

export async function buildEvidenceLinks(
  claims: Array<{ id: string; text: string }>,
  verifications: Record<string, { sources?: Array<{ title: string; uri: string }> }>,
): Promise<EvidenceLink[]> {
  const links: EvidenceLink[] = [];

  for (const claim of claims) {
    const verification = verifications[claim.id];
    const sources = verification?.sources ?? [];

    const validations = await Promise.all(
      sources.map((s) => validateSourceUrl(s.uri, s.title, claim.text)),
    );

    const overallEvidenceScore =
      validations.length === 0
        ? 0
        : Math.round(validations.reduce((sum, v) => sum + v.evidenceScore, 0) / validations.length);

    links.push({
      claimId: claim.id,
      sources: validations,
      overallEvidenceScore,
    });
  }

  return links;
}
