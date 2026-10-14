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
import { getProvider } from '../providers/registry.js';
import { DEFAULT_SCAN_PROVIDER, resolveApiKey } from './provider-keys.js';
import { GeminiGroundingRetriever } from '../providers/gemini_provider.js';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever.js';
import { consensusVerify, type NamedProvider } from '../consensus/consensus_engine.js';
import { classifyApiError } from '../providers/extraction-error.js';
import { guardVerdict } from '../lib/verdict-guard.js';

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

/** The consensus fan-out: one shared retriever plus the participating providers. */
export interface ConsensusRig {
  retriever: Retriever;
  namedProviders: NamedProvider[];
}

/** Everything the verify stage needs: the single provider, or a consensus rig. */
export interface Verifier {
  provider: LLMProvider;
  consensusRig: ConsensusRig | null;
  /** The provider id the verify stage resolved to (e.g. 'gemini'); names the verdict's provenance. */
  providerName?: string;
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
 * Build the consensus rig: a provider-agnostic Retriever plus the named
 * providers to fan out to. A provider whose API key is missing is SKIPPED here
 * rather than throwing — a missing key must not abort a consensus scan (it
 * simply means one fewer voter).
 */
function buildConsensusRig(names: ProviderName[]): ConsensusRig {
  const namedProviders: NamedProvider[] = [];
  for (const name of names) {
    try {
      const apiKey = resolveApiKey(name);
      namedProviders.push({ name, provider: getProvider(apiKey, name) });
    } catch {
      // Missing key → not a participant. Not fatal: consensus still runs with
      // whatever providers ARE configured.
    }
  }
  return { retriever: buildRetriever(), namedProviders };
}

/**
 * Select the consensus retriever behind the provider-agnostic Retriever seam.
 * OpenAI web search is primary (funded key, not throttled like the free-tier
 * gemini native googleSearch); gemini grounding is the alternate fallback. If
 * neither key exists, retrieval yields [] and providers judge from parametric
 * knowledge.
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

function buildConsensusRigIfEnabled(names: StageNames, pipelineConfig?: PipelineConfig): ConsensusRig | null {
  return names.consensusEnabled
    ? buildConsensusRig(pipelineConfig?.consensusProviders ?? DEFAULT_CONSENSUS_PROVIDERS)
    : null;
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
  const isRateLimit = err instanceof Error
    && (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'));
  const result: VerificationResult = {
    claimId: claim.id,
    status: 'unverified',
    explanation: isRateLimit
      ? 'Rate limit reached. Upgrade for higher limits: https://faultline.nxtg.ai/pricing'
      : 'Verify failed after retries.',
    sources: [],
  };
  return flagApiError ? { ...result, apiError: true, apiErrorReason: classifyApiError(err) } : result;
}

/**
 * Bind who produced a verdict and when. The provider id is the one the engine
 * resolved; the model and time come from the provider when it reports them
 * (Gemini reports the model Google served), else from its configured model and
 * the moment the call returned. A verdict whose check never ran carries none.
 * Honor System #2, GoPMO 1.18.11.3 P1a.
 */
function withProvenance(result: VerificationResult, verifier: Verifier): VerificationResult {
  if (!result || typeof result !== 'object' || result.apiError === true) return result;
  const own = result.provenance;
  return {
    ...result,
    provenance: {
      ...(own ?? {}),
      // The provider id is always the one the engine resolved, never the provider's own claim.
      provider: verifier.providerName ?? verifier.provider.name,
      model: typeof own?.model === 'string' && own.model.length > 0 ? own.model : verifier.provider.modelId,
      verifiedAt: typeof own?.verifiedAt === 'string' ? own.verifiedAt : new Date().toISOString(),
    },
  };
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
      return withProvenance(await verifier.provider.verifyClaim(claim), verifier);
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
      const result = guardVerdict(await verifyOneClaim(claims[i], verifier, flagExhaustedRetries), claims[i].id);
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
