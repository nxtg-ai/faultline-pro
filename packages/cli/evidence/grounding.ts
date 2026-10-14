/**
 * Google grounding Links (Gemini Grounding with Google Search). Google's terms
 * forbid "using Links to identify destination pages for crawling or scraping",
 * so no evidence request, robots.txt included, is ever sent to this host
 * (emma-soul ruling al:07b45f0562efbbf0, 2026-10-14).
 */
export const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';

export function isGroundingRedirect(uri: string): boolean {
  try {
    return new URL(uri).hostname.toLowerCase() === GROUNDING_REDIRECT_HOST;
  } catch {
    return false;
  }
}
