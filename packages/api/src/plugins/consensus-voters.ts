import type { FastifyRequest, FastifyReply } from 'fastify';
import { CONSENSUS_VOTER_PROVIDERS, canVoteInConsensus, consensusVoterRefusal, type PipelineConfig } from '@nxtg/faultline/cli/verify-runner.js';
import { isSharedFailureReason } from '@nxtg/faultline/consensus/consensus_engine.js';

/**
 * Prehandler: refuse a consensus request that names no provider able to vote.
 *
 * A consensus scan with an empty voter list, or with only providers that cannot
 * vote (Perplexity has no grounded entry point), used to run extraction, fuse zero
 * votes into an 'unverified' verdict, answer 200, spend money and use a scan of
 * quota. It is refused here with a 400 instead, before any provider call.
 *
 * Also refused with a 400: a voter named more than once (one model's opinion
 * counted as several, at several times the spend), and mock as a voter unless
 * every stage of the run is mock. mock always answers supported, so beside a real
 * voter it outvotes it, and on a paid run it passes off a made-up verdict.
 *
 * Unknown provider names never reach this check: the body schema enum refuses
 * them with a 400 first. Runs after enforceConsensusEntitlement (a caller without
 * the plan gets the 403, not a validation hint) and before the SSE hijack on the
 * stream route, so the caller gets a plain JSON 400.
 */
export async function validateConsensusVoters(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = request.body as { provider?: unknown; pipelineConfig?: { consensus?: boolean; consensusProviders?: unknown } } | undefined;
  const config = body?.pipelineConfig;
  if (config?.consensus !== true || config.consensusProviders === undefined) return;

  const requested = Array.isArray(config.consensusProviders) ? config.consensusProviders as unknown[] : [];
  if (requested.length === 0) {
    reply.status(400).send({
      error: 'consensus_providers_empty',
      message: 'consensusProviders must name at least one provider that can vote.',
      voters: CONSENSUS_VOTER_PROVIDERS,
    });
    return;
  }

  const cannotVote = requested.filter((name) => typeof name !== 'string' || !canVoteInConsensus(name));
  if (cannotVote.length > 0) {
    reply.status(400).send({
      error: 'consensus_provider_cannot_vote',
      message: `These providers cannot vote in consensus: ${cannotVote.map(String).join(', ')}.`,
      providers: cannotVote,
      voters: CONSENSUS_VOTER_PROVIDERS,
    });
    return;
  }

  // Both routes run a body with no provider (or an unknown one) on gemini.
  const provider = typeof body?.provider === 'string' ? body.provider : 'gemini';
  const refusal = consensusVoterRefusal(provider, config as PipelineConfig);
  if (refusal) {
    reply.status(400).send({ ...refusal, voters: CONSENSUS_VOTER_PROVIDERS });
  }
}

interface ConsensusScanLike {
  verifications?: unknown;
}

/**
 * True when a consensus scan finished without a single voter taking part: every
 * verified claim's votes failed, or it had none because its source search
 * failed (an API error). Such a run checked nothing, so the route reports failure
 * instead of a 200 that reads as a clean result. A claim whose search ran and
 * found no source has no votes either (no source, no verdict), but it was
 * checked: it is unverified, not a voter failure. A scan that verified no claims,
 * or that was not a consensus scan, is never a no-voter run.
 */
export function consensusHadNoVoters(result: ConsensusScanLike): boolean {
  const verifications = result.verifications;
  if (typeof verifications !== 'object' || verifications === null) return false;
  const verdicts = Object.values(verifications as Record<string, { consensus?: unknown; providerVotes?: unknown; apiError?: unknown }>);
  if (verdicts.length === 0) return false;
  return verdicts.every((v) => {
    if (v === null || typeof v !== 'object' || v.consensus === undefined) return false;
    const votes = Array.isArray(v.providerVotes) ? v.providerVotes as Array<{ apiError?: boolean }> : [];
    if (votes.length === 0) return v.apiError === true;
    return votes.every((vote) => vote?.apiError === true);
  });
}

export const CONSENSUS_UNAVAILABLE_MESSAGE = 'No consensus voter returned a verdict, so nothing was checked. No scan was counted.';

/** A retry cannot succeed against an empty provider account, so this text never asks for one. */
export const CONSENSUS_OUT_OF_CREDITS_MESSAGE =
  'No consensus voter returned a verdict because the provider account is out of credits, so nothing was checked. No scan was counted. Re-running will not help until the account has credits again.';

type VerdictLike = { apiErrorReason?: unknown; providerVotes?: unknown };

/**
 * The one reason every failure in a no-voter consensus scan shares, when it is
 * a reason the engine carries (an empty provider account, an unreadable reply,
 * a reply cut off at its ceiling). Each failed vote counts; a claim with no
 * votes counts its own reason (its source search failed). Undefined when the
 * failures differ or any has no reason.
 */
export function consensusSharedFailureReason(result: ConsensusScanLike): string | undefined {
  const verifications = result.verifications;
  if (typeof verifications !== 'object' || verifications === null) return undefined;
  const reasons: unknown[] = [];
  for (const v of Object.values(verifications as Record<string, VerdictLike>)) {
    if (v === null || typeof v !== 'object') return undefined;
    const votes = Array.isArray(v.providerVotes) ? v.providerVotes as Array<{ apiError?: boolean; apiErrorReason?: unknown }> : [];
    if (votes.length === 0) reasons.push(v.apiErrorReason);
    else for (const vote of votes) if (vote?.apiError === true) reasons.push(vote.apiErrorReason);
  }
  const first = reasons[0];
  if (!isSharedFailureReason(first)) return undefined;
  return reasons.every((r) => r === first) ? first : undefined;
}

/**
 * The 502 body (and stream error event fields) for a consensus scan where no
 * voter took part. It carries `reason` when every failure shares one, and the
 * out-of-credits text when that reason is provider_out_of_credits.
 */
export function consensusUnavailableBody(result: ConsensusScanLike): { error: 'consensus_unavailable'; message: string; reason?: string } {
  const reason = consensusSharedFailureReason(result);
  const message = reason === 'provider_out_of_credits' ? CONSENSUS_OUT_OF_CREDITS_MESSAGE : CONSENSUS_UNAVAILABLE_MESSAGE;
  return { error: 'consensus_unavailable', message, ...(reason ? { reason } : {}) };
}
