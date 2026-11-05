import type { FastifyRequest } from 'fastify';
import { billableVerdictCount } from '@nxtg/faultline/lib/verdict-guard.js';
import { getUsageMeter } from '../store/usage.js';

/**
 * The monthly scan quota counts a scan only when its delivered result holds at
 * least one billable verdict (supported, contradicted or mixed, at least one
 * source, not an API error). A scan where every claim failed at the provider,
 * came back unverified or had no source delivered nothing billable, so it
 * costs the customer no scan. The rule itself is billableVerdictCount, the one
 * every billed count uses.
 */
export function meterScan(keyId: string, verifications: unknown): void {
  if (billableVerdictCount(verifications) > 0) getUsageMeter().increment(keyId);
}

/**
 * POST /scan and POST /scan/upload are counted by the server's onResponse hook,
 * after the reply is sent. The handler records here what it delivered, and the
 * hook reads it back, so the count happens once and only for a billable scan.
 */
const delivered = new WeakMap<FastifyRequest, number>();

export function recordDeliveredScan(request: FastifyRequest, verifications: unknown): void {
  delivered.set(request, billableVerdictCount(verifications));
}

export function deliveredBillableVerdicts(request: FastifyRequest): number {
  return delivered.get(request) ?? 0;
}
