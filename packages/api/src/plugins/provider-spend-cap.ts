import type { FastifyRequest, FastifyReply } from 'fastify';
import { getProviderSpendStatus, isProviderSpendCapEnabled } from '../store/provider-spend.js';
import type { ManagedScanCostEvent } from '../store/costs.js';
import { isAdminKeyId } from './auth.js';
import { isServerKeyId, resolveEntitledTier } from './consensus-entitlement.js';
import { nextMonthResetEpoch } from './usage-cap.js';

type Tier = ManagedScanCostEvent['tier'];

/**
 * The tiers this gate refuses once the month's budget is spent. Every other tier
 * passes it. `GET /usage` reports this list as `providerBudget.appliesTo`.
 */
export const SPEND_CAP_TIERS: readonly Tier[] = Object.freeze(['free', 'anon'] as const);
const SPEND_CAP_TIER_SET = new Set<Tier>(SPEND_CAP_TIERS);

/**
 * The TRUSTED tier for this gate.
 *
 * - No key at all counts as anonymous. Every gated route runs requireApiKey or
 *   requireAdmin first, so this branch is defensive.
 * - The server's own key with `x-user-tier`: `resolveEntitledTier` as is. It
 *   honours the header from that key alone and fails closed to 'free' on an
 *   unknown value.
 * - The server's own key with no tier header (absent or empty): 'free'. The web
 *   front end sends some calls (critique, for one) through the server key with
 *   no header, so such a caller cannot be told apart from free traffic. Paid
 *   callers through the server key must send their tier. `resolveEntitledTier`
 *   still reads no header as an internal (enterprise) call for consensus and
 *   the verify cap; only this gate differs.
 * - A keystore key: the tier its own permissions grant; any header is ignored.
 *   `resolveEntitledTier` names a keystore key without the 'pro' permission
 *   'personal', which is its catch-all, not proof of a paid plan. The rate
 *   limiter and the monthly quota call that same key 'free', so this gate does
 *   too. A keystore key with the 'admin' permission is an operator key and passes.
 *
 * Never use `resolveTierFromRequest` here: it trusts the header from any caller.
 */
export function resolveSpendCapTier(keyId: string | undefined, headerTier?: string | string[]): Tier {
  if (!keyId) return 'anon';
  if (isServerKeyId(keyId)) {
    const raw = Array.isArray(headerTier) ? headerTier[0] : headerTier;
    if (raw === undefined || raw === '') return 'free';
    return resolveEntitledTier(keyId, headerTier);
  }
  const tier = resolveEntitledTier(keyId, headerTier);
  if (tier === 'pro' || tier === 'enterprise') return tier;
  if (isAdminKeyId(keyId)) return 'enterprise';
  return 'free';
}

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
 * SCOPE: free and anonymous traffic only (`SPEND_CAP_TIERS`). Paid tiers pass
 * this gate; their own per-key limits (burst rate limit, monthly scan quota)
 * bound what each paid key can spend.
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

  // NO CALLER-SUPPLIED EXEMPTION. Every scan on this API spends OUR env-configured
  // provider keys (there is no BYOK path through it), so no caller-supplied
  // value may buy a way past the budget. The tier comes from the trusted
  // resolver: `x-user-tier` counts only from the server's own key, so a free
  // key that sends `x-user-tier: pro` is still refused. Paid tiers are exempt
  // because each paid key is already bounded by its own per-key caps; the fleet
  // budget protects runway from free and anonymous traffic, which has no plan
  // paying for it.
  const tier = resolveSpendCapTier(request.keyId, request.headers['x-user-tier']);
  if (!SPEND_CAP_TIER_SET.has(tier)) return;

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
