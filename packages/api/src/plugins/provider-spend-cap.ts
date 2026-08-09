import type { FastifyRequest, FastifyReply } from 'fastify';
import { resolveTierFromRequest } from '../store/costs.js';
import { getProviderSpendStatus, isOwnSpend, isProviderSpendCapEnabled } from '../store/provider-spend.js';
import { nextMonthResetEpoch } from './usage-cap.js';

/**
 * Provider-spend budget prehandler — the RUNWAY gate (A-110 item 1).
 *
 * Three gates now run in front of a scan, and they are deliberately distinct:
 *   rateLimitScan       — per-MINUTE burst throttle       (abuse)   → 429
 *   enforceMonthlyCap   — per-KEY monthly scan quota      (margin)  → 402
 *   enforceProviderSpend— FLEET monthly USD at providers  (runway)  → 503
 *
 * 503 (not 402) is the honest code: the budget belongs to Faultline, not to the
 * caller. The customer did nothing wrong and there is nothing for them to buy —
 * capacity is temporarily gone and returns at the month boundary, so `Retry-After`
 * points there.
 *
 * DORMANT by default (`FAULTLINE_PROVIDER_SPEND_CAP` off) — the ledger records
 * from day one, but refusing scans is new outward behavior and is Asif's flip.
 *
 * Headers are set only on the DENY path. The allow path deliberately sets none:
 * `/scan/stream` hijacks the reply for SSE, which drops every `reply.header()`
 * (see docs — Fastify hijack drops headers), so allow-path budget headers would
 * be a lie on the streaming routes. Budget position is read from `GET /usage`.
 *
 * Must run AFTER requireApiKey (needs request.keyId to resolve the tier).
 */
export async function enforceProviderSpendCap(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isProviderSpendCapEnabled()) return; // dormant — ledger on, gate inactive

  // BYOK scans spend the customer's key, not our budget — never gated by it.
  // Resolved through the SAME path the cost event uses (`x-user-tier`, FW's
  // authoritative header) so the gate and the ledger cannot disagree on which
  // scans are ours.
  const tier = resolveTierFromRequest(request.keyId ?? 'unknown', request.headers['x-user-tier']);
  if (!isOwnSpend(tier)) return;

  const status = getProviderSpendStatus();
  if (!status.exhausted) return;

  const resetEpoch = nextMonthResetEpoch();
  reply
    .header('X-Provider-Spend-Cap', status.capUsd.toFixed(2))
    .header('X-Provider-Spend-Used', status.spentUsd.toFixed(2))
    .header('X-Provider-Spend-Reset', String(resetEpoch))
    .header('Retry-After', String(Math.max(1, resetEpoch - Math.floor(Date.now() / 1000))))
    .status(503)
    .send({
      error: 'Monthly provider budget exhausted. Scanning is paused until the budget resets.',
      month: status.month,
      capUsd: status.capUsd,
      spentUsd: Number(status.spentUsd.toFixed(4)),
      resetEpoch,
    });
}
