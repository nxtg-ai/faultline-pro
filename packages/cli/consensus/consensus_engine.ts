import type {
  Claim,
  ClaimStatus,
  Source,
  VerificationResult,
  ProviderVote,
  ConsensusMeta,
  ApiErrorReason,
} from '../types.js';
import type { LLMProvider, Retriever } from '../providers/base_provider.js';
import { sanitizeVerifyError } from '../services/verify-error.js';
import { classifyApiError } from '../providers/extraction-error.js';
import { RetrievalError } from '../providers/retrieval-error.js';

/**
 * Grounded multi-model consensus engine — "ground every claim by construction".
 *
 * Pipeline per claim:
 *   1. RETRIEVE shared sources via a provider-agnostic Retriever.
 *      - The search failed: no provider is asked, and the claim is unverified
 *        with apiError (not checked, never cached or billed).
 *      - The search ran and found nothing: no provider is asked, and the claim
 *        is unverified (checked, nothing to judge it against).
 *   2. FAN OUT to N providers IN PARALLEL, each judging the claim against the
 *      SAME retrieved sources (verifyClaimGrounded). Only with at least one
 *      shared source does any provider vote.
 *   3. FUSE the per-provider verdicts into ONE top-level verdict.
 *
 * Locks:
 *   - LOCK A: every providerVote.sources AND the fused top-level sources = the
 *     shared retrieved set (NOT a per-provider union).
 *   - LOCK B: consensus.providerCount counts ONLY providers that returned a REAL
 *     verdict (status ∈ supported|contradicted|mixed). Dead/errored providers
 *     are excluded from the count but STILL listed in providerVotes (status
 *     carries the failure) so the UI can show "unavailable".
 */

/** A provider paired with the display name used in its vote. */
export interface NamedProvider {
  name: string;
  provider: LLMProvider;
}

const REAL_STATUSES: ReadonlySet<ClaimStatus> = new Set<ClaimStatus>([
  'supported',
  'contradicted',
  'mixed',
]);

/** A real verdict is one a provider actually produced (not an error/unverified). */
function isRealVerdict(vote: ProviderVote): boolean {
  return REAL_STATUSES.has(vote.status);
}

/**
 * Run ONE provider against the shared sources, never throwing. A provider that
 * errors, lacks the grounded entry point, or returns 'unverified' resolves to
 * an unavailable vote — it does NOT reject the Promise.all (LOCK B resilience).
 */
async function runProviderVote(
  named: NamedProvider,
  claim: Claim,
  sources: Source[],
): Promise<ProviderVote> {
  const { name, provider } = named;

  if (typeof provider.verifyClaimGrounded !== 'function') {
    return {
      provider: name,
      status: 'unverified',
      sources,
      explanation: 'Provider does not support grounded consensus verification.',
    };
  }

  try {
    const result = await provider.verifyClaimGrounded(claim, sources);
    return {
      provider: name,
      status: result.status,
      // LOCK A: pin the SHARED retrieved set, ignore any per-provider sources.
      sources,
      explanation: result.explanation,
      // Propagate a provider that self-reported a non-run (e.g. grounded gemini
      // caught its own 429 and returned apiError) so fusion can flag it.
      apiError: result.apiError,
      ...(result.apiError && result.apiErrorReason ? { apiErrorReason: result.apiErrorReason } : {}),
    };
  } catch (err) {
    // Provider's grounded verify threw (quota/auth/5xx). Sanitize — never leak
    // the raw provider payload into a vote that can reach a customer report —
    // and flag apiError so fusion/caches treat this vote as "not checked".
    console.error(`Consensus provider ${name} grounded-verify failed for claim ${claim.id}:`, err);
    return {
      provider: name,
      status: 'unverified',
      sources,
      explanation: sanitizeVerifyError(err),
      apiError: true,
      // Keep why the call failed (rate limit, empty account, ...) so fusion and reports can say it.
      apiErrorReason: classifyApiError(err),
    };
  }
}

/**
 * Failure reasons a fused result carries when every failed vote shares one: the
 * two reply reasons, and an empty provider account, which no re-run can fix.
 */
const SHARED_REASONS: ReadonlySet<ApiErrorReason> = new Set<ApiErrorReason>([
  'provider_unparseable',
  'output_truncated',
  'provider_out_of_credits',
]);

/** The reason every failed vote shares, or undefined when they differ, any vote has none, or it is not carried. */
function sharedReasonOf(errored: ProviderVote[]): ApiErrorReason | undefined {
  const first = errored[0]?.apiErrorReason;
  if (!first || !SHARED_REASONS.has(first)) return undefined;
  return errored.every((v) => v.apiErrorReason === first) ? first : undefined;
}

/** Pick the plurality status among real verdicts; tie/empty handled by caller. */
function tallyStatuses(realVotes: ProviderVote[]): {
  topStatus: ClaimStatus;
  topCount: number;
  tie: boolean;
} {
  const counts = new Map<ClaimStatus, number>();
  for (const v of realVotes) {
    counts.set(v.status, (counts.get(v.status) ?? 0) + 1);
  }
  let topStatus: ClaimStatus = 'mixed';
  let topCount = 0;
  let tie = false;
  for (const [status, count] of counts) {
    if (count > topCount) {
      topStatus = status;
      topCount = count;
      tie = false;
    } else if (count === topCount) {
      tie = true;
    }
  }
  return { topStatus, topCount, tie };
}

/**
 * Fuse per-provider votes into one verdict. Exported for direct unit testing of
 * the fusion logic independently of any live provider/retriever.
 */
export function fuseVotes(
  claim: Claim,
  sources: Source[],
  votes: ProviderVote[],
): VerificationResult {
  const realVotes = votes.filter(isRealVerdict);
  const providerCount = realVotes.length; // LOCK B

  // No real verdict from anyone (all dead/errored) → unverified, but sources
  // still = the shared retrieved set (grounded-by-construction holds).
  if (providerCount === 0) {
    // Distinguish "all providers ERRORED" (not checked → apiError, must not be
    // cached) from "all providers returned a real 'unverified' judgment"
    // (checked, inconclusive). If any vote carried a provider error, the claim
    // was never actually checked.
    const errored = votes.filter((v) => v.apiError);
    const anyError = errored.length > 0;
    // When every failed vote failed for the same carried reason (an unreadable reply,
    // a reply cut off at its ceiling, or an empty provider account), the claim
    // carries that reason; any other mix keeps the default reason.
    const sharedReason = anyError ? sharedReasonOf(errored) : undefined;
    return {
      claimId: claim.id,
      status: 'unverified',
      explanation: 'No provider returned a verdict; consensus unavailable.',
      sources,
      ...(anyError ? { apiError: true } : {}),
      ...(sharedReason ? { apiErrorReason: sharedReason } : {}),
      consensus: { agreement: 'split', providerCount: 0, dissenting: 0 },
      providerVotes: votes,
    };
  }

  const { topStatus, topCount, tie } = tallyStatuses(realVotes);

  // A genuine tie among ≥2 distinct statuses → disagreement → 'mixed' / 'split'.
  const disagreementTie = tie && topCount < providerCount;
  const status: ClaimStatus = disagreementTie ? 'mixed' : topStatus;

  const dissenting = realVotes.filter((v) => v.status !== status).length;

  let agreement: ConsensusMeta['agreement'];
  if (disagreementTie) {
    agreement = 'split';
  } else if (dissenting === 0) {
    agreement = 'unanimous';
  } else {
    agreement = 'majority';
  }

  const explanation = buildFusedExplanation(status, realVotes, agreement);

  return {
    claimId: claim.id,
    status,
    explanation,
    sources, // LOCK A
    consensus: { agreement, providerCount, dissenting },
    providerVotes: votes,
    // adversarial: intentionally absent — later increment.
  };
}

/** Concise fused rationale drawn from the agreeing providers. */
function buildFusedExplanation(
  status: ClaimStatus,
  realVotes: ProviderVote[],
  agreement: ConsensusMeta['agreement'],
): string {
  const agreeing = realVotes.filter((v) => v.status === status);
  const lead = agreeing.find((v) => v.explanation)?.explanation
    ?? realVotes.find((v) => v.explanation)?.explanation
    ?? 'Fused from provider verdicts.';
  const names = realVotes.map((v) => v.provider).join(', ');
  return `Consensus (${agreement}, ${realVotes.length} providers: ${names}): ${lead}`;
}

/** The explanation on a claim whose search ran and returned no source. */
export const NO_SOURCES_EXPLANATION = 'No sources were found for this claim, so no verdict was given.';

/** A consensus result with no provider votes: the claim never reached a provider. */
function noVoteResult(claim: Claim, explanation: string): VerificationResult {
  return {
    claimId: claim.id,
    status: 'unverified',
    explanation,
    sources: [],
    consensus: { agreement: 'split', providerCount: 0, dissenting: 0 },
    providerVotes: [],
  };
}

/**
 * Verify a claim by grounded multi-model consensus.
 *
 * @param claim     the claim to verify
 * @param retriever provider-agnostic source fetcher (e.g. GeminiGroundingRetriever)
 * @param providers the named providers to fan out to (verify stage only)
 */
export async function consensusVerify(
  claim: Claim,
  retriever: Retriever,
  providers: NamedProvider[],
): Promise<VerificationResult> {
  // 1. RETRIEVE shared sources. Any rejection is a failed search, whatever the
  // retriever threw; it is classified so the claim says why it was not checked.
  let sources: Source[];
  try {
    sources = await retriever.retrieve(claim.text);
  } catch (err) {
    const failure = RetrievalError.fromError(err);
    return { ...noVoteResult(claim, failure.message), apiError: true, apiErrorReason: failure.reason };
  }
  const retrievedAt = new Date().toISOString();

  // A claim with no retrieved source gets no verdict: nothing is asked, nothing is spent.
  if (sources.length === 0) return noVoteResult(claim, NO_SOURCES_EXPLANATION);

  // 2. FAN OUT in parallel; each runProviderVote is pre-caught (LOCK B).
  const votes = await Promise.all(
    providers.map((named) => runProviderVote(named, claim, sources)),
  );

  // 3. FUSE, then bind who produced the verdict and when.
  const fused = fuseVotes(claim, sources, votes);
  if (fused.apiError) return fused;
  // Provenance names only the providers that returned a real verdict; a failed
  // one stays listed in providerVotes as unavailable. With no real verdict
  // there is no producer to name, so there is no provenance.
  const voters = providers.filter((p, i) => isRealVerdict(votes[i]));
  if (voters.length === 0) return fused;
  return {
    ...fused,
    provenance: {
      provider: 'consensus',
      model: voters.map((p) => `${p.name}:${p.provider.modelId}`).join('+'),
      verifiedAt: new Date().toISOString(),
      retriever: retriever.name,
      retrievedAt,
    },
  };
}
