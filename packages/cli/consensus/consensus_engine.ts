import type {
  Claim,
  ClaimStatus,
  Source,
  VerificationResult,
  ProviderVote,
  ConsensusMeta,
} from '../types.js';
import type { LLMProvider, Retriever } from '../providers/base_provider.js';
import { sanitizeVerifyError } from '../services/verify-error.js';

/**
 * Grounded multi-model consensus engine — "ground every claim by construction".
 *
 * Pipeline per claim:
 *   1. RETRIEVE shared sources via a provider-agnostic Retriever.
 *   2. FAN OUT to N providers IN PARALLEL, each judging the claim against the
 *      SAME retrieved sources (verifyClaimGrounded).
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
    };
  }
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
    const anyError = votes.some((v) => v.apiError);
    return {
      claimId: claim.id,
      status: 'unverified',
      explanation: 'No provider returned a verdict; consensus unavailable.',
      sources,
      ...(anyError ? { apiError: true } : {}),
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
  // 1. RETRIEVE shared sources (never throws → [] on failure).
  let sources: Source[] = [];
  try {
    sources = await retriever.retrieve(claim.text);
  } catch {
    sources = [];
  }

  // 2. FAN OUT in parallel; each runProviderVote is pre-caught (LOCK B).
  const votes = await Promise.all(
    providers.map((named) => runProviderVote(named, claim, sources)),
  );

  // 3. FUSE.
  return fuseVotes(claim, sources, votes);
}
