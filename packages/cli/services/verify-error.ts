/**
 * Map a raw provider/verification error into a CUSTOMER-SAFE explanation.
 *
 * A verification failure means "this claim was never checked" (provider quota,
 * auth, 5xx, timeout, network) — NOT "checked and unsupported". The customer
 * report must say that in plain language and MUST NEVER leak the raw provider
 * payload (quota JSON blobs, stack traces, model ids, keys, internal URLs).
 *
 * Origin: 2026-07-13 prod incident — a free-tier Gemini 429 dumped the full
 * Google `RESOURCE_EXHAUSTED` JSON into a paying customer's report `Explanation`
 * field (geminiService.ts + every provider emitted `Verify failed: ${raw}`).
 *
 * Ops still get the raw error: every call site keeps its `console.error(raw)`,
 * and the result keeps `apiError: true` so consumers/caches can tell
 * "not-checked" from "checked-unsupported" and refuse to cache the failure.
 */
export function sanitizeVerifyError(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).toLowerCase();

  // Rate limit / quota — the most common and the one that leaked in prod.
  if (/\b429\b|resource_exhausted|quota|rate[ _-]?limit|free_tier|too many requests/.test(raw)) {
    return 'Verification temporarily unavailable — the verification provider is rate-limited right now. This claim was not checked; re-run the scan shortly.';
  }
  // Auth / permission — a misconfigured or missing key.
  if (/\b40[13]\b|invalid[ _-]?api[ _-]?key|unauthenticated|unauthorized|permission[ _-]?denied|api key/.test(raw)) {
    return 'Verification could not run — the verification provider rejected the request (configuration issue). This claim was not checked.';
  }
  // Server / timeout / network — transient provider trouble.
  if (/\b5\d\d\b|timeout|timed out|econn|etimedout|network|fetch failed|socket|unavailable|503/.test(raw)) {
    return 'Verification temporarily unavailable — the verification provider had a transient error. This claim was not checked; re-run the scan shortly.';
  }
  // Everything else — never echo the raw message.
  return 'Verification could not be completed for this claim. This claim was not checked.';
}

/**
 * True if a scan result contains any verification that never ran (apiError).
 * A result with an unchecked claim must NOT be cached (client or server) — a
 * cached error report is a served defect that survives the key/config fix.
 */
export function hasUncheckedClaim(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const verifications = (result as { verifications?: Record<string, unknown> }).verifications;
  if (verifications && typeof verifications === 'object') {
    for (const v of Object.values(verifications)) {
      if (v && typeof v === 'object' && (v as { apiError?: unknown }).apiError === true) return true;
    }
  }
  // Some shapes carry verification inline on claims.
  const claims = (result as { claims?: Array<Record<string, unknown>> }).claims;
  if (Array.isArray(claims)) {
    for (const c of claims) {
      if (c && (c as { apiError?: unknown }).apiError === true) return true;
    }
  }
  return false;
}
