/**
 * Google grounding Links (Gemini Grounding with Google Search). Google's terms
 * forbid "using Links to identify destination pages for crawling or scraping",
 * so no evidence request, robots.txt included, is ever sent to this host
 * (emma-soul ruling al:07b45f0562efbbf0, 2026-10-14).
 */
export const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';

/**
 * True when `uri` points at Google's grounding host, however it is spelled:
 * any case, and with or without the trailing root dot ("host." resolves to
 * the same host; the URL parser also decodes "%2e" to it). Fable seat,
 * 2026-10-14: the dotted spelling got past an exact compare.
 */
export function isGroundingRedirect(uri: string): boolean {
  try {
    return new URL(uri).hostname.toLowerCase().replace(/\.+$/, '') === GROUNDING_REDIRECT_HOST;
  } catch {
    return false;
  }
}
