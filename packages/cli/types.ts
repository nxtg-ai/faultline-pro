
export type ClaimType = 'fact' | 'opinion' | 'interpretation';

export type ClaimStatus = 'supported' | 'contradicted' | 'mixed' | 'unverified' | 'loading' | 'skipped';

export interface Claim {
  id: string;
  text: string;
  type: ClaimType;
  importance: number; // 1 to 5
  // P-08b NOTE (TQ-003): Add `dependencies?: string[]` — array of claim IDs that this
  // claim logically depends on being true. Required for true weakest-chain traversal and
  // full claim-graph visualization. Deferred from Kaggle branch to avoid complicating
  // the stash/merge decision. Extraction prompts for all three providers will need updating
  // to identify logical dependencies when this is added.
}

export interface Source {
  title: string;
  uri: string;
  /**
   * The relevant span of evidence text for this source (additive, optional for
   * backward-compat). Populated by retrievers that can map a quoted/cited span
   * to each URL (e.g. OpenAIWebSearchRetriever via url_citation start/end index).
   * Consumed by the inc-2 NLI gate; safe to omit elsewhere.
   */
  snippet?: string;
}

/**
 * Consensus metadata attached to a fused multi-provider verdict.
 * Present only on verdicts produced by the consensus engine (consensusVerify).
 *
 * - `agreement`: 'unanimous' when every real verdict agrees; 'majority' when a
 *   plurality agrees but at least one dissents; 'split' on a tie / no clear
 *   plurality.
 * - `providerCount` (LOCK B): the number of providers that returned a REAL
 *   verdict (status ∈ supported|contradicted|mixed). Dead/errored providers
 *   (claude-on-400, missing key, network) are EXCLUDED from this count.
 * - `dissenting`: number of real verdicts whose status differs from the fused
 *   majority status.
 */
export interface ConsensusMeta {
  agreement: 'unanimous' | 'majority' | 'split';
  providerCount: number;
  dissenting?: number;
}

/**
 * One provider's individual vote inside a consensus verdict.
 * Failed providers ARE listed here (so the UI can render "unavailable"), with
 * their failure status — but they do not count toward consensus.providerCount.
 *
 * `sources` (LOCK A): the SHARED retrieved set every provider judged against,
 * NOT the provider's own returned sources.
 */
export interface ProviderVote {
  provider: string;
  status: ClaimStatus;
  sources: Source[];
  explanation?: string;
}

export interface VerificationResult {
  claimId: string;
  status: ClaimStatus;
  explanation: string;
  sources: Source[];
  /**
   * True when verification could NOT be performed due to a provider/API error
   * (quota 429, model 503, network) rather than a real grounding verdict.
   * `status` will be 'unverified' in this case, but that 'unverified' means
   * "we never checked", NOT "we checked and found no support". Consumers MUST
   * distinguish the two — silently treating an API failure as an unsupported
   * claim is the failure mode this flag exists to prevent.
   */
  apiError?: boolean;
  /**
   * Consensus metadata — present only on fused multi-provider verdicts emitted
   * by the consensus engine. Absent on the single-provider path (additive,
   * backward-compatible).
   */
  consensus?: ConsensusMeta;
  /**
   * Per-provider votes — present only on consensus verdicts. Lists every
   * participating provider including failed ones (status carries the failure).
   */
  providerVotes?: ProviderVote[];
  /**
   * Adversarial probe layer — RESERVED for a later increment (probes + safety-
   * response classification). Intentionally left absent for now.
   * TODO(adversarial): populate when the adversarial layer is built.
   */
  adversarial?: Record<string, unknown>;
}

export interface AnalysisState {
  claims: Claim[];
  verifications: Record<string, VerificationResult>;
  isProcessing: boolean;
  progressMessage: string;
  step: 'idle' | 'extracting' | 'verifying' | 'complete';
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  critique?: string;
  improvedPrompt?: string;
}
