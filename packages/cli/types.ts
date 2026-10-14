
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
  /**
   * The passage of the fetched page that best matches the claim, with the fetch
   * time (evidence/passage.ts). Taken from the page's own bytes, never from the
   * model's reply; `snippet` above is model-derived and is not evidence.
   */
  evidence?: SourceEvidence;
}

/** Passages from a second retriever, kept apart from the verdict's own sources. */
export interface IndependentEvidence {
  /** The retriever's name, e.g. 'openai-web-search'. */
  retriever: string;
  /** The model that ran the search, when the retriever reports one. */
  model?: string;
  /** When the search returned (ISO 8601). */
  retrievedAt: string;
  /** The retriever's result pages, each with what fetching it found. No model-written snippet. */
  sources: Source[];
}

/** What fetching one cited source found (Honor System #3, GoPMO 1.18.11.3 P1b). */
export interface SourceEvidence {
  /**
   * ok: a passage matched. no_match: the page was read and no sentence matched
   * the claim. http_error: the page answered non-2xx. unsupported_type: not
   * HTML or plain text (a PDF, an image). blocked: the URL or a redirect target
   * was refused (private address, not http/https). fetch_failed: network error
   * or timeout, or the site's robots.txt could not be read (RFC 9309: then
   * nothing there is fetched). not_fetched: deliberately not requested (see `reason`).
   */
  status: 'ok' | 'no_match' | 'http_error' | 'unsupported_type' | 'blocked' | 'fetch_failed' | 'not_fetched';
  /**
   * Why a source was not fetched. provider_terms: the link came from Gemini
   * Grounding with Google Search, whose terms forbid "using Links to identify
   * destination pages for crawling or scraping" (emma-soul ruling
   * al:07b45f0562efbbf0, 2026-10-14). robots: that site's robots.txt
   * disallows FaultlineEvidence for the page or a redirect hop (emma-soul
   * al:15b443bc1ccf7a4e). Present only with status not_fetched.
   */
  reason?: 'provider_terms' | 'robots';
  /** The matched passage, at most 300 Unicode code points, ellipsis included; null unless status is ok. */
  passage: string | null;
  /** When the fetch finished or failed (ISO 8601). Absent when nothing was fetched. */
  fetchedAt?: string;
  /** The URL the page was finally read from, when redirects changed it. */
  finalUri?: string;
  httpStatus?: number;
  /** SHA-256 (hex) of the bytes read, so the page can be re-checked later. */
  contentSha256?: string;
  /** True when the page was longer than the read cap and only its start was read. */
  truncated?: boolean;
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
  /** True when this provider's grounded verify never ran (quota/auth/5xx). */
  apiError?: boolean;
}

/** What a provider failure was, after the engine's retries: 429, 503, a timeout, or anything else. */
export type ApiErrorReason = 'rate_limited' | 'provider_unavailable' | 'timeout' | 'provider_error';

/**
 * Who produced a verdict and when, bound at the provider call itself (Honor
 * System point #2, GoPMO 1.18.11.3 P1a). Absent on a verdict whose check never
 * ran (`apiError`).
 */
export interface VerdictProvenance {
  /** Provider id: 'gemini', 'openai', 'claude', 'perplexity', 'mock', a registered name, or 'consensus'. */
  provider: string;
  /** Model id. Gemini reports the model that served the request (`modelVersion`); otherwise the configured model. Consensus lists `name:model` per voter, joined by '+'. */
  model: string;
  /** When the provider call that produced this verdict returned (ISO 8601). */
  verifiedAt: string;
  /**
   * What retrieved the evidence: 'gemini-grounding' for a Gemini grounded call
   * (Google Search runs inside the same request), or the consensus rig's
   * retriever name. Absent when no retrieval ran.
   */
  retriever?: string;
  /**
   * When the evidence was retrieved (ISO 8601). A Gemini grounded call searches
   * and judges in one request, so it equals `verifiedAt`; consensus records when
   * its shared retrieval returned. Absent when no retrieval ran.
   */
  retrievedAt?: string;
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
   * Why a claim got no verdict: set only together with `apiError: true`, by the
   * engine's retry ladder after its final attempt. A full scan reports it per
   * unserved claim so a refund can say what was lost (emma-soul refund ruling,
   * GoPMO 1.18.11.3.12). Absent on a real verdict and on a consensus result.
   */
  apiErrorReason?: ApiErrorReason;
  /**
   * True when the model's reply was not parseable JSON and the engine fell back
   * to status 'mixed' (geminiService.verifyClaim). Absent otherwise. It lets a
   * consumer tell an "inconclusive" verdict from an "unparseable" one; it never
   * changes the status (verdict-accuracy prereg G0 §3).
   */
  parseFallback?: boolean;
  /**
   * Google Search Suggestions for the grounded prompt behind this verdict,
   * passed through unaltered from `candidates[0].groundingMetadata`. Google's
   * grounding terms require them to be shown, unaltered, wherever this
   * verdict's explanation or sources are shown to the end user. Present only
   * on a Gemini Grounding with Google Search verdict that returned them;
   * absent on every other path. Never persisted to disk by Faultline.
   */
  searchEntryPoint?: { renderedContent: string };
  /** Who produced this verdict and when (see VerdictProvenance). */
  provenance?: VerdictProvenance;
  /**
   * Passages found by a second, independent retriever whose terms allow
   * fetching its result pages, run beside the verdict (GoPMO 1.18.11.3;
   * emma-soul authorization al:e615798a8e8109c0). Never merged into
   * `sources`: those are what the verdict was grounded on.
   */
  independentEvidence?: IndependentEvidence;
  /** The Google Search queries the grounded prompt ran (same source, same rule). */
  webSearchQueries?: string[];
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
