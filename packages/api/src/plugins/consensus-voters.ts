import type { FastifyRequest, FastifyReply } from 'fastify';
import { CONSENSUS_VOTER_PROVIDERS, canVoteInConsensus } from '@nxtg/faultline/cli/verify-runner.js';

/**
 * Prehandler: refuse a consensus request that names no provider able to vote.
 *
 * A consensus scan with an empty voter list, or with only providers that cannot
 * vote (Perplexity has no grounded entry point), used to run extraction, fuse zero
 * votes into an 'unverified' verdict, answer 200, spend money and use a scan of
 * quota. It is refused here with a 400 instead, before any provider call.
 *
 * Unknown provider names never reach this check: the body schema enum refuses
 * them with a 400 first. Runs after enforceConsensusEntitlement (a caller without
 * the plan gets the 403, not a validation hint) and before the SSE hijack on the
 * stream route, so the caller gets a plain JSON 400.
 */
export async function validateConsensusVoters(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = request.body as { pipelineConfig?: { consensus?: boolean; consensusProviders?: unknown } } | undefined;
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
  }
}

interface ConsensusScanLike {
  verifications?: unknown;
}

/**
 * True when a consensus scan finished without a single voter taking part: every
 * verified claim's votes failed (or there were none). Such a run checked nothing,
 * so the route reports failure instead of a 200 that reads as a clean result.
 * A scan that verified no claims, or that was not a consensus scan, is never a
 * no-voter run.
 */
export function consensusHadNoVoters(result: ConsensusScanLike): boolean {
  const verifications = result.verifications;
  if (typeof verifications !== 'object' || verifications === null) return false;
  const verdicts = Object.values(verifications as Record<string, { consensus?: unknown; providerVotes?: unknown }>);
  if (verdicts.length === 0) return false;
  return verdicts.every((v) => {
    if (v === null || typeof v !== 'object' || v.consensus === undefined) return false;
    const votes = Array.isArray(v.providerVotes) ? v.providerVotes as Array<{ apiError?: boolean }> : [];
    return votes.every((vote) => vote?.apiError === true);
  });
}

export const CONSENSUS_UNAVAILABLE_MESSAGE = 'No consensus voter returned a verdict, so nothing was checked. No scan was counted.';
