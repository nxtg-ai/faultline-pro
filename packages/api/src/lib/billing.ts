import { billingSummary, type BillingSummary } from '@nxtg/faultline/lib/verdict-guard.js';

/**
 * `result` with `billing` added: how many of its claims were billed, how many
 * were not, and why each was not (billingSummary). Computed from the
 * verifications the caller is given, after every read guard, so a cached or
 * stored result carries it too. It reports billing and changes none of it:
 * the claim meter and the scan quota decide on their own, with the same rule.
 */
export function withBilling<T extends object>(result: T): T & { billing: BillingSummary } {
  return { ...result, billing: billingSummary((result as { verifications?: unknown }).verifications) };
}
