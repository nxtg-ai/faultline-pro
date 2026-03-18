/**
 * Wikipedia built-in provider (D-124)
 *
 * Uses Wikipedia's search API to find relevant articles and checks if the
 * claim text appears supported, contradicted, or unverifiable from snippets.
 */

import type { FaultlineProvider, VerificationResult } from '../store/providers.js';

interface WikiSearchResult {
  query?: {
    search?: Array<{ snippet: string; title: string }>;
  };
}

export const wikipediaProvider: FaultlineProvider = {
  name: 'wikipedia',

  async verify(claim: string): Promise<VerificationResult> {
    const query = encodeURIComponent(claim.slice(0, 100));
    const url =
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query}` +
      `&format=json&srlimit=3&origin=*`;

    let data: WikiSearchResult;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Faultline/1.0 (claim-forensics)' } });
      if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
      data = (await res.json()) as WikiSearchResult;
    } catch {
      return { status: 'unverified', explanation: 'Wikipedia API unavailable.', confidence: 0 };
    }

    const results = data?.query?.search ?? [];
    if (results.length === 0) {
      return { status: 'unverified', explanation: 'No Wikipedia articles found for this claim.', confidence: 0.1 };
    }

    // Simple heuristic: check if key claim terms appear in snippets
    const claimLower = claim.toLowerCase();
    const combinedSnippets = results.map(r => r.snippet.replace(/<[^>]+>/g, '')).join(' ').toLowerCase();

    // Extract meaningful words (>4 chars) from claim for matching
    const claimWords = claimLower.split(/\W+/).filter(w => w.length > 4);
    const matchCount = claimWords.filter(w => combinedSnippets.includes(w)).length;
    const matchRatio = claimWords.length > 0 ? matchCount / claimWords.length : 0;

    const topTitle = results[0]?.title ?? 'Wikipedia';

    if (matchRatio >= 0.6) {
      return {
        status: 'supported',
        explanation: `Wikipedia article "${topTitle}" contains supporting evidence.`,
        confidence: 0.5 + matchRatio * 0.3,
      };
    } else if (matchRatio >= 0.3) {
      return {
        status: 'mixed',
        explanation: `Wikipedia article "${topTitle}" partially addresses the claim.`,
        confidence: 0.3 + matchRatio * 0.2,
      };
    } else {
      return {
        status: 'unverified',
        explanation: `Wikipedia search returned articles but no strong match for the claim.`,
        confidence: 0.1,
      };
    }
  },
};
