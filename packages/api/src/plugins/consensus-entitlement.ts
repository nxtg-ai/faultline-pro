import type { FastifyRequest, FastifyReply } from 'fastify';
import { resolveTier, type ManagedScanCostEvent } from '../store/costs.js';

type Tier = ManagedScanCostEvent['tier'];

/**
 * Plans that include grounded multi-model consensus. Asif re-ruling 2026-09-30:
 * ENTERPRISE ONLY (al:252ac668b119d9cf) — a consensus scan costs $0.20–0.71
 * (docs/unit-economics-MEASURED-2026-07-04.md), so it is priced per contract.
 * Pro keeps the 2-stage search-grounded pipeline.
 */
const CONSENSUS_TIERS = new Set<Tier>(['enterprise']);

const FORWARDABLE_TIERS = new Set<Tier>(['enterprise', 'pro', 'personal', 'free', 'anon', 'userkey']);

/**
 * The tier a request is ENTITLED to — for feature decisions, not telemetry.
 *
 * `x-user-tier` is caller-supplied (ae4987a: a spoofable header must not buy a
 * money control). Only the server's own `FAULTLINE_API_KEY` (keyId 'admin') is
 * held by faultline-web, which resolves the plan from Clerk + billing server-side
 * before forwarding it, so the header is honoured from that key alone. A
 * forwarded value we do not recognise (e.g. 'widget') is not a plan: fail closed
 * to 'free'. With no header the admin key is an internal caller → enterprise.
 *
 * Any keystore key gets the tier its own permissions grant; the header is ignored.
 * (resolveTier never returns 'enterprise' for a keystore key today, so direct API
 * keys cannot reach consensus until an enterprise permission exists.)
 */
export function resolveEntitledTier(keyId: string, headerTier?: string | string[]): Tier {
  if (keyId !== 'admin') return resolveTier(keyId);
  const raw = Array.isArray(headerTier) ? headerTier[0] : headerTier;
  if (raw === undefined || raw === '') return 'enterprise';
  return FORWARDABLE_TIERS.has(raw as Tier) ? (raw as Tier) : 'free';
}

export function isConsensusEntitled(tier: Tier): boolean {
  return CONSENSUS_TIERS.has(tier);
}

/**
 * Prehandler: refuse `pipelineConfig.consensus === true` for plans without it.
 *
 * Refuse, never downgrade: a silently single-model scan would be served as if it
 * were the consensus the caller asked for. Runs before the SSE hijack so the
 * caller gets a plain 403. Must run AFTER requireApiKey (needs request.keyId).
 */
export async function enforceConsensusEntitlement(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = request.body as { pipelineConfig?: { consensus?: boolean } } | undefined;
  if (body?.pipelineConfig?.consensus !== true) return;

  const tier = resolveEntitledTier(request.keyId ?? 'unknown', request.headers['x-user-tier']);
  if (isConsensusEntitled(tier)) return;

  reply.status(403).send({
    error: 'consensus_not_in_plan',
    message: 'Multi-model consensus is included in the Enterprise plan.',
    plan: tier,
  });
}
