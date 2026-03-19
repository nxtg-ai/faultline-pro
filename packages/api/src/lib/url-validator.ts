export interface SourceValidation {
  uri: string;
  title: string;
  available: boolean;
  statusCode: number;
  lastModified?: string;
  evidenceScore: number; // 0–100
}

export interface EvidenceLink {
  claimId: string;
  sources: SourceValidation[];
  overallEvidenceScore: number; // 0–100, average of source scores
}

// Injectable fetcher — default uses global fetch, can be swapped in tests
type FetchFn = (uri: string) => Promise<{ status: number; headers: Record<string, string> }>;

let _fetcher: FetchFn = async (uri: string) => {
  try {
    const res = await fetch(uri, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
      headers: { 'user-agent': 'Faultline-EvidenceBot/1.0' },
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers };
  } catch {
    return { status: 0, headers: {} };
  }
};

export function setUrlFetcher(fn: FetchFn): void {
  _fetcher = fn;
}

export function resetUrlFetcher(): void {
  _fetcher = async (uri: string) => {
    try {
      const res = await fetch(uri, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
        headers: { 'user-agent': 'Faultline-EvidenceBot/1.0' },
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { status: res.status, headers };
    } catch {
      return { status: 0, headers: {} };
    }
  };
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
  const result = await _fetcher(uri);
  const available = result.status >= 200 && result.status < 400;
  const evidenceScore = scoreSource(result, title, claimText);

  return {
    uri,
    title,
    available,
    statusCode: result.status,
    lastModified: result.headers['last-modified'],
    evidenceScore,
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
