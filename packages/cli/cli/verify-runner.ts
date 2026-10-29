/**
 * The verify stage, shared by the quick scan (scan()) and the full scan
 * (verifyFullScan / scan(mode 'full')): stage provider resolution, the
 * consensus rig, the per-claim retry ladder and the bounded-concurrency loop.
 *
 * One implementation so the two scan modes cannot drift on provider choice,
 * concurrency or apiError semantics.
 */
import type { Claim, VerificationResult } from '../types.js';
import type { LLMProvider, Retriever } from '../providers/base_provider.js';
import { getProvider, builtInProviderIdOf } from '../providers/registry.js';
import { DEFAULT_SCAN_PROVIDER, resolveApiKey } from './provider-keys.js';
import { GeminiGroundingRetriever } from '../providers/gemini_provider.js';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever.js';
import { consensusVerify, type NamedProvider } from '../consensus/consensus_engine.js';
import { classifyApiError } from '../providers/extraction-error.js';
import { OUT_OF_CREDITS_VERIFY_MESSAGE } from '../services/verify-error.js';
import { guardVerdict } from '../lib/verdict-guard.js';
import { attachEvidence, type EvidenceOptions } from '../evidence/passage.js';
import { attachIndependentEvidence, type IndependentEvidenceOptions } from '../evidence/independent.js';

/** Claims verified at the same time within one scan. */
export const VERIFY_CONCURRENCY = 8;

/**
 * Normalise a requested verify concurrency: a finite number >= 1 is floored to an
 * integer; anything else (0, negative, NaN, a non-number) falls back to
 * VERIFY_CONCURRENCY, so a bad value can never stall a run at 0 workers.
 *
 * @example
 *   resolveVerifyConcurrency(4)   // 4
 *   resolveVerifyConcurrency(2.7) // 2
 *   resolveVerifyConcurrency(0)   // 8
 */
export function resolveVerifyConcurrency(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : VERIFY_CONCURRENCY;
}

/** Provider names supported by the Faultline provider registry. */
export type ProviderName = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

/**
 * Optional per-stage provider overrides.
 * Each field defaults to the top-level `provider` if absent.
 *
 * Note: `synthesisProvider` is accepted for forward compatibility but is a
 * no-op in the current API pipeline (complianceReport is a pure function).
 * It will be wired up when `generateCritiqueAndPrompt` migrates to the API
 * (requires FR-1 POST /scan/stream).
 */
export interface PipelineConfig {
  extractionProvider?: ProviderName;    // provider for extractClaims()
  verificationProvider?: ProviderName;  // provider for verifyClaim()
  synthesisProvider?: ProviderName;     // reserved — no-op in current API pipeline
  /**
   * Opt-in grounded multi-model consensus for the VERIFY stage (additive).
   * When true, each claim is verified by fanning out to multiple providers in
   * parallel, all judging the SAME retrieved sources, then fusing the verdicts
   * (see consensus_engine.ts). Extraction stays single-provider.
   * When absent/false, the existing single-provider verify path runs UNCHANGED.
   */
  consensus?: boolean;
  /**
   * Provider names participating in consensus verify (default: gemini, openai,
   * claude). Only used when `consensus` is true.
   */
  consensusProviders?: ProviderName[];
}

/** Callback for reporting scan progress to the caller (e.g., a CLI spinner). */
export type ScanProgressCallback = (message: string) => void;

/** Fired after each claim is verified, enabling progressive streaming. */
export type ScanClaimCallback = (
  claim: Claim,
  verdict: VerificationResult,
  index: number,
  total: number,
) => void;

// openai FIRST: it's the funded, non-throttled provider + the retriever, so it is
// the reliable always-present voter. gemini (free-tier) + claude (credits) are bonus
// voters when available. Order matters: a degraded bonus provider must never be the
// sole/first dependency of a grounded scan.
const DEFAULT_CONSENSUS_PROVIDERS: ProviderName[] = ['openai', 'gemini', 'claude'];

/**
 * The providers whose adapters can cast a consensus vote (they implement
 * verifyClaimGrounded, judging a claim against shared retrieved sources).
 * Perplexity searches on its own and has no grounded entry point, so it cannot vote.
 * mock is the offline voter: it always answers supported, so it may vote only in
 * a run where every stage is mock (see consensusVoterRefusal).
 */
export const CONSENSUS_VOTER_PROVIDERS: readonly ProviderName[] = Object.freeze(['openai', 'gemini', 'claude', 'mock']);

/** True when `name` can cast a consensus vote. */
export function canVoteInConsensus(name: string): boolean {
  return (CONSENSUS_VOTER_PROVIDERS as readonly string[]).includes(name);
}

/** Thrown before any provider call when a consensus scan has no voter it can run. */
export class ConsensusUnavailableError extends Error {
  constructor(message = 'No consensus voter is available: none of the requested providers has an API key configured.') {
    super(message);
    this.name = 'ConsensusUnavailableError';
  }
}

export function isConsensusUnavailableError(err: unknown): err is ConsensusUnavailableError {
  return err instanceof ConsensusUnavailableError;
}

/** Why a consensus voter list is refused before any provider call. */
export interface ConsensusVoterRefusal {
  error: 'consensus_provider_duplicate' | 'consensus_mock_voter_not_offline';
  message: string;
  /** The voter names at fault. */
  providers: string[];
}

/** Thrown before any provider call when a consensus voter list is refused. */
export class InvalidConsensusVotersError extends Error {
  readonly refusal: ConsensusVoterRefusal;

  constructor(refusal: ConsensusVoterRefusal) {
    super(refusal.message);
    this.name = 'InvalidConsensusVotersError';
    this.refusal = refusal;
  }
}

export function isInvalidConsensusVotersError(err: unknown): err is InvalidConsensusVotersError {
  return err instanceof InvalidConsensusVotersError;
}

function voterRefusalForStages(names: StageNames, voters: readonly string[]): ConsensusVoterRefusal | null {
  // The same model named twice is one opinion counted twice, at twice the spend.
  const duplicates = [...new Set(voters.filter((name, i) => voters.indexOf(name) !== i))];
  if (duplicates.length > 0) {
    return {
      error: 'consensus_provider_duplicate',
      message: `Each consensus voter may be named once. Named more than once: ${duplicates.join(', ')}.`,
      providers: duplicates,
    };
  }
  // mock always answers supported. Beside a real voter it would outvote it; alone
  // on a paid run it would pass off a made-up verdict as checked.
  if (voters.includes('mock') && !isOfflineRun(names, voters)) {
    return {
      error: 'consensus_mock_voter_not_offline',
      message: 'mock may vote only in a fully offline run: extraction, verification and every voter on mock.',
      providers: ['mock'],
    };
  }
  return null;
}

/** True when every stage of the run, voters included, is mock, so no paid provider is called. */
function isOfflineRun(names: StageNames, voters: readonly string[]): boolean {
  return names.extractionName === 'mock' && names.verificationName === 'mock' && voters.every((name) => name === 'mock');
}

/**
 * The refusal for a consensus scan's voter list, or null when it may run (or
 * consensus is off). Refused: a voter named more than once, and mock beside any
 * stage or voter that is not mock. The API checks this before a scan and the
 * engine checks it again where the consensus rig is built.
 */
export function consensusVoterRefusal(providerName?: string, pipelineConfig?: PipelineConfig): ConsensusVoterRefusal | null {
  const names = resolveStageNames(providerName, pipelineConfig);
  if (!names.consensusEnabled) return null;
  return voterRefusalForStages(names, pipelineConfig?.consensusProviders ?? DEFAULT_CONSENSUS_PROVIDERS);
}

/**
 * The voters a consensus rig built now would run: the named providers that can
 * vote and have an API key, in order. A provider with no key is dropped, as the
 * rig drops it.
 */
export function participatingConsensusVoters(names: readonly ProviderName[]): ProviderName[] {
  return names.filter((name) => {
    if (!canVoteInConsensus(name)) return false;
    try {
      resolveApiKey(name);
      return true;
    } catch {
      return false;
    }
  });
}

/** The consensus fan-out: one shared retriever plus the participating providers. */
export interface ConsensusRig {
  retriever: Retriever;
  namedProviders: NamedProvider[];
}

/** Everything the verify stage needs: the single provider, or a consensus rig. */
export interface Verifier {
  provider: LLMProvider;
  consensusRig: ConsensusRig | null;
  /** The provider id the verify stage resolved to (e.g. 'gemini'); names the verdict's provenance and selects its retriever. */
  providerName: string;
}

/** The provider names each stage resolves to. */
interface StageNames {
  extractionName: string;
  verificationName: string;
  consensusEnabled: boolean;
}

/**
 * Resolve the provider name for each stage.
 *
 * Consensus mode defaults EVERY stage to the funded openai path so a grounded
 * scan never depends on the free-tier gemini SPOF (extraction + verify + the
 * web-search retriever all run on the funded OpenAI key; gemini is a bonus
 * consensus voter when not throttled). Explicit pipelineConfig overrides win.
 * EXCEPTION: `mock` is the offline/keyless sentinel — it must never be
 * force-upgraded to a real API call. An explicit `provider: 'mock'` is honored
 * across stages even under consensus.
 */
function resolveStageNames(providerName?: string, pipelineConfig?: PipelineConfig): StageNames {
  const resolvedProvider = providerName || DEFAULT_SCAN_PROVIDER;
  const consensusEnabled = pipelineConfig?.consensus === true;
  const stageDefault =
    consensusEnabled && resolvedProvider !== 'mock' ? 'openai' : resolvedProvider;
  return {
    extractionName: pipelineConfig?.extractionProvider ?? stageDefault,
    verificationName: pipelineConfig?.verificationProvider ?? stageDefault,
    consensusEnabled,
  };
}

/**
 * The providers each stage of a scan runs on, after defaults and overrides.
 * `consensusVoters` lists the voters that run (named, able to vote, with an API
 * key) and is null when consensus is off. Used to price and label spend
 * by the providers that actually did the work, never by the caller's outer label.
 */
export interface StageProviders {
  extraction: string;
  verification: string;
  consensusVoters: string[] | null;
}

export function resolveStageProviders(providerName?: string, pipelineConfig?: PipelineConfig): StageProviders {
  const names = resolveStageNames(providerName, pipelineConfig);
  return {
    extraction: names.extractionName,
    verification: names.verificationName,
    consensusVoters: names.consensusEnabled
      ? participatingConsensusVoters(pipelineConfig?.consensusProviders ?? DEFAULT_CONSENSUS_PROVIDERS)
      : null,
  };
}

/**
 * Build the consensus rig: a provider-agnostic Retriever plus the named
 * providers to fan out to. A provider whose API key is missing is SKIPPED here
 * rather than throwing — a missing key must not abort a consensus scan (it
 * simply means one fewer voter). A provider that cannot vote is skipped too.
 *
 * @throws ConsensusUnavailableError when no voter is left, before any provider
 * call, so a consensus scan never runs with nobody to vote.
 */
function buildConsensusRig(names: ProviderName[], offline: boolean): ConsensusRig {
  // Missing key → not a participant. Not fatal: consensus still runs with
  // whatever providers ARE configured.
  const namedProviders: NamedProvider[] = participatingConsensusVoters(names)
    .map((name) => ({ name, provider: getProvider(resolveApiKey(name), name) }));
  if (namedProviders.length === 0) throw new ConsensusUnavailableError();
  return { retriever: offline ? OFFLINE_RETRIEVER : buildRetriever(), namedProviders };
}

/** Retrieves nothing, so a fully offline run makes no web-search call. */
const OFFLINE_RETRIEVER: Retriever = { name: 'offline', retrieve: async () => [] };

/**
 * Select the consensus retriever behind the provider-agnostic Retriever seam.
 * OpenAI web search is primary (funded key, not throttled like the free-tier
 * gemini native googleSearch); gemini grounding is the alternate fallback. If
 * neither key exists, the Gemini retriever rejects with RetrievalError, so each
 * claim reads as not checked and no provider is asked.
 */
function buildRetriever(): Retriever {
  let openaiKey = '';
  try {
    openaiKey = resolveApiKey('openai');
  } catch {
    openaiKey = '';
  }
  if (openaiKey) return new OpenAIWebSearchRetriever(openaiKey);

  let geminiKey = '';
  try {
    geminiKey = resolveApiKey('gemini');
  } catch {
    geminiKey = '';
  }
  return new GeminiGroundingRetriever(geminiKey);
}

/**
 * @throws InvalidConsensusVotersError when the voter list is refused (see
 * consensusVoterRefusal), before any provider is built, so a caller that skips
 * the API's check is refused too.
 */
function buildConsensusRigIfEnabled(names: StageNames, pipelineConfig?: PipelineConfig): ConsensusRig | null {
  if (!names.consensusEnabled) return null;
  const voters = pipelineConfig?.consensusProviders ?? DEFAULT_CONSENSUS_PROVIDERS;
  const refusal = voterRefusalForStages(names, voters);
  if (refusal) throw new InvalidConsensusVotersError(refusal);
  return buildConsensusRig(voters, isOfflineRun(names, voters));
}

/**
 * Resolve the extraction provider and the verifier for a scan that runs both
 * stages. Key resolution order is extraction then verification, and the same
 * instance is reused when both stages name the same provider.
 *
 * @throws when a stage's API key is missing (the caller reports it).
 */
export function resolveScanProviders(
  providerName?: string,
  pipelineConfig?: PipelineConfig,
): { extractionProvider: LLMProvider; verifier: Verifier } {
  const names = resolveStageNames(providerName, pipelineConfig);
  const extractionApiKey = resolveApiKey(names.extractionName);
  const verificationApiKey = resolveApiKey(names.verificationName);
  const extractionProvider = getProvider(extractionApiKey, names.extractionName);
  const provider = names.extractionName === names.verificationName
    ? extractionProvider
    : getProvider(verificationApiKey, names.verificationName);
  return {
    extractionProvider,
    verifier: { provider, consensusRig: buildConsensusRigIfEnabled(names, pipelineConfig), providerName: names.verificationName },
  };
}

/**
 * Resolve only the extraction provider (an estimate needs no verify key).
 *
 * @throws when the extraction API key is missing.
 */
export function resolveExtractionProvider(
  providerName?: string,
  pipelineConfig?: PipelineConfig,
): LLMProvider {
  const { extractionName } = resolveStageNames(providerName, pipelineConfig);
  return getProvider(resolveApiKey(extractionName), extractionName);
}

/**
 * Resolve only the verifier (a run over claims extracted earlier needs no
 * extraction key).
 *
 * @throws when the verification API key is missing.
 */
export function resolveVerifier(providerName?: string, pipelineConfig?: PipelineConfig): Verifier {
  const names = resolveStageNames(providerName, pipelineConfig);
  const provider = getProvider(resolveApiKey(names.verificationName), names.verificationName);
  return { provider, consensusRig: buildConsensusRigIfEnabled(names, pipelineConfig), providerName: names.verificationName };
}

/** Options for one verify-stage run. */
export interface RunVerificationOptions {
  onProgress?: ScanProgressCallback;
  onClaimVerified?: ScanClaimCallback;
  /** When aborted, no further claim is started; claims already running finish. */
  signal?: AbortSignal;
  /**
   * Mark a claim whose provider threw on every retry as `apiError: true` (default on).
   * Such a claim got no verdict: the scan must count it in verificationErrors, report
   * degraded, and never be cached (the cache refuses results with apiError). Before
   * 2026-10-13 the quick scan left it off, so a thrown provider error read as a plain
   * 'unverified' verdict and could be cached for 24 hours.
   */
  flagExhaustedRetries?: boolean;
  /** Claims verified at the same time (default VERIFY_CONCURRENCY; see resolveVerifyConcurrency). */
  concurrency?: number;
  /** When set, each verdict's cited sources are fetched for evidence passages before it is reported (GoPMO 1.18.11.3 P1b). */
  evidence?: EvidenceOptions;
  /** When set, a second retriever's passages are attached as independentEvidence before the verdict is reported. */
  independentEvidence?: IndependentEvidenceOptions;
}

/** What one verify-stage run produced. */
export interface VerificationRun {
  /** Verdicts keyed by claim id (a duplicate id keeps the last verdict). */
  verifications: Record<string, VerificationResult>;
  /** Verdict per input position; undefined for a claim that was never started. */
  results: Array<VerificationResult | undefined>;
  /** Claims that were started, in input order. */
  attempted: Claim[];
  /** Claims never started because the run was aborted, in input order. */
  notAttempted: Claim[];
}

/**
 * Classify the error a claim's final attempt threw. Shared with extraction
 * (providers/extraction-error.ts) so both stages name a 429, a 503 or a
 * timeout the same way.
 */
export { classifyApiError };

function exhaustedRetryResult(claim: Claim, err: unknown, flagApiError: boolean): VerificationResult {
  const reason = classifyApiError(err);
  const isRateLimit = err instanceof Error
    && (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'));
  const result: VerificationResult = {
    claimId: claim.id,
    status: 'unverified',
    // An empty provider account is tested first: a Faultline plan upgrade does not refill it.
    explanation: reason === 'provider_out_of_credits'
      ? OUT_OF_CREDITS_VERIFY_MESSAGE
      : isRateLimit
        ? 'Rate limit reached. Upgrade for higher limits: https://faultline.nxtg.ai/pricing'
        : 'Verify failed after retries.',
    sources: [],
  };
  return flagApiError ? { ...result, apiError: true, apiErrorReason: reason } : result;
}

/**
 * The retrieval a built-in provider performs inside its own verify call, keyed
 * by built-in provider id. Only these may carry a retriever: a provider that
 * labels itself `gemini-grounding` would otherwise exempt its own citations
 * from the evidence fetch.
 */
const ENGINE_RETRIEVERS: Readonly<Record<string, string>> = Object.freeze({ gemini: 'gemini-grounding' });

/**
 * Bind who produced a verdict and when, at the call site. `providerName` is the
 * provider id the caller resolved and is recorded as the provider. The retriever
 * comes from ENGINE_RETRIEVERS, and only when `provider` is an instance the
 * built-in factory for that same id made (builtInProviderIdOf): a provider a
 * caller or plugin supplies, under any id, gets no retriever. verifiedAt (and
 * retrievedAt, for a provider that searches inside the same call) is
 * `returnedAt`, the moment the call returned. None of these is taken from the
 * provider's own object, so a retriever the provider set on itself is dropped.
 * Only the model is: Gemini reports the model Google served, else
 * `provider.modelId` (the configured model) is used. A verdict whose check
 * never ran carries none. Every caller that runs `verifyClaim` outside the
 * runner (the admin verify route) binds provenance with this, so billing sees
 * the same retriever either way.
 */
export function bindEngineProvenance(
  result: VerificationResult,
  providerName: string,
  provider: Pick<LLMProvider, 'modelId'>,
  returnedAt: string,
): VerificationResult {
  if (!result || typeof result !== 'object' || result.apiError === true) return result;
  const own = result.provenance;
  const builtInId = builtInProviderIdOf(provider);
  const retriever = builtInId !== undefined && builtInId === providerName
    && Object.prototype.hasOwnProperty.call(ENGINE_RETRIEVERS, builtInId)
    ? ENGINE_RETRIEVERS[builtInId]
    : undefined;
  return {
    ...result,
    provenance: {
      provider: providerName,
      model: typeof own?.model === 'string' && own.model.length > 0 ? own.model : provider.modelId,
      verifiedAt: returnedAt,
      ...(retriever !== undefined ? { retriever, retrievedAt: returnedAt } : {}),
    },
  };
}

function withProvenance(result: VerificationResult, verifier: Verifier, returnedAt: string): VerificationResult {
  return bindEngineProvenance(result, verifier.providerName, verifier.provider, returnedAt);
}

/**
 * Verify one claim. Consensus is internally resilient (never throws), so it
 * bypasses the single-provider retry ladder (3 attempts, jittered backoff).
 */
async function verifyOneClaim(claim: Claim, verifier: Verifier, flagExhaustedRetries: boolean): Promise<VerificationResult> {
  if (verifier.consensusRig) {
    return consensusVerify(claim, verifier.consensusRig.retriever, verifier.consensusRig.namedProviders);
  }
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await verifier.provider.verifyClaim(claim);
      return withProvenance(result, verifier, new Date().toISOString());
    } catch (err) {
      if (attempt >= 2) return exhaustedRetryResult(claim, err, flagExhaustedRetries);
      await new Promise(r => setTimeout(r, delay + Math.floor(Math.random() * 500)));
      delay *= 2;
    }
  }
}

/**
 * Verify `claims` in order with `options.concurrency` workers (default
 * VERIFY_CONCURRENCY). Every claim is
 * attempted unless `signal` aborts, in which case the rest are reported in
 * `notAttempted`.
 */
export async function runVerification(
  claims: Claim[],
  verifier: Verifier,
  options: RunVerificationOptions = {},
): Promise<VerificationRun> {
  const { onProgress, onClaimVerified, signal, flagExhaustedRetries = true } = options;
  const concurrency = resolveVerifyConcurrency(options.concurrency ?? VERIFY_CONCURRENCY);
  const verifications: Record<string, VerificationResult> = {};
  const results: Array<VerificationResult | undefined> = new Array(claims.length).fill(undefined);
  let cursor = 0;
  const runSlot = async (): Promise<void> => {
    while (cursor < claims.length && !signal?.aborted) {
      const i = cursor++;
      onProgress?.(`Verifying claim ${i + 1}/${claims.length}...`);
      const checked = guardVerdict(await verifyOneClaim(claims[i], verifier, flagExhaustedRetries), claims[i].id);
      const withSources = options.evidence ? await attachEvidence(checked, claims[i].text, options.evidence) : checked;
      const result = options.independentEvidence
        ? await attachIndependentEvidence(withSources, claims[i].text, options.independentEvidence)
        : withSources;
      verifications[claims[i].id] = result;
      results[i] = result;
      onClaimVerified?.(claims[i], result, i, claims.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, claims.length) }, runSlot));
  return {
    verifications,
    results,
    attempted: claims.slice(0, cursor),
    notAttempted: claims.slice(cursor),
  };
}
