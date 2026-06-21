import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Claim, VerificationResult, AnalysisState } from '../types.js';
import type { LLMProvider, Retriever } from '../providers/base_provider.js';
import { getProvider } from '../providers/registry.js';
import { GeminiGroundingRetriever } from '../providers/gemini_provider.js';
import { consensusVerify, type NamedProvider } from '../consensus/consensus_engine.js';
import { generateComplianceReport, type ComplianceReport } from '../compliance/report_generator.js';
import { runAllRules, runRules, type Finding } from '../rules/index.js';

const VERIFY_CONCURRENCY = 8;

// ── FR-3: Per-stage model routing ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────

export interface ScanResult {
  input: string;
  provider: string;
  claims: Claim[];
  verifications: Record<string, VerificationResult>;
  overallRisk: AnalysisState['overallRisk'];
  complianceReport: ComplianceReport;
  ruleFindings: Finding[];
  /**
   * Count of claims whose verification FAILED to run due to a provider/API
   * error (quota 429, model 503, network) — NOT a real verdict.
   */
  verificationErrors?: number;
  /**
   * True when one or more verifications could not be performed. A degraded scan
   * is NOT trustworthy: 'unverified' results may mean "never checked", not
   * "no support found". Surfaces LOUDLY so a paid/public surface never presents
   * a confident scorecard built on un-run verifications (e.g. a quota-exhausted
   * key returning all-'unverified'). Consumers should show a degraded banner
   * and must not bill or consume quota for a fully-degraded scan.
   */
  degraded?: boolean;
}

function calculateRisk(
  verifications: Record<string, VerificationResult>,
): AnalysisState['overallRisk'] {
  const values = Object.values(verifications);
  const contradicted = values.filter((v) => v.status === 'contradicted').length;
  const mixed = values.filter((v) => v.status === 'mixed').length;
  if (contradicted > 2) return 'critical';
  if (contradicted > 0 || mixed > 2) return 'high';
  if (mixed > 0) return 'medium';
  return 'low';
}

// ── Sentence-level claim coverage guarantee ───────────────────────────────────

/**
 * Split text into independently verifiable sentence candidates.
 * Filters out fragments shorter than 3 words (not verifiable on their own).
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|(?<=[.!?])$/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && /[a-zA-Z]/.test(s) && s.split(/\s+/).length >= 3);
}

function normalizeSentence(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Guarantee that every independently verifiable sentence in the input text
 * is represented by at least one claim.
 *
 * If an LLM merges or drops sentences, this function adds a synthetic `fact`
 * claim for each unrepresented sentence. Synthetic IDs use an 's' prefix to
 * distinguish them from LLM-extracted claims (e.g. "s1", "s2").
 *
 * This is the primary defence against claim-merging behaviour and works
 * identically across all providers.
 */
export function guaranteeClaimPerSentence(text: string, claims: Claim[]): Claim[] {
  const sentences = splitSentences(text);
  if (sentences.length < 2) return claims;

  const result = [...claims];
  let idx = result.length + 1;

  for (const sentence of sentences) {
    const normSentence = normalizeSentence(sentence);
    if (!normSentence) continue;

    // Use the first 40 normalised chars as a fingerprint to detect coverage.
    const fingerprint = normSentence.slice(0, 40);
    const covered = result.some(c => {
      const nc = normalizeSentence(c.text);
      return nc.includes(fingerprint) || normSentence.includes(nc.slice(0, 40));
    });

    if (!covered) {
      result.push({ id: `s${idx++}`, text: sentence, type: 'fact', importance: 3 });
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

export function filterClaimsForVerification(claims: Claim[]): Claim[] {
  return claims
    .filter((c) => c.type === 'fact' && c.importance >= 2)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 8);
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

/**
 * Resolve the API key for a given provider name.
 * Returns '' for 'mock' (no key required).
 * Throws if the required env var is missing.
 */
function resolveApiKey(name: string): string {
  if (name === 'mock') return '';
  const keyMap: Record<string, string> = {
    claude: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
  };
  const envVar = keyMap[name] || 'GEMINI_API_KEY';
  const key = process.env[envVar] || '';
  if (!key) {
    const hint = name === 'gemini'
      ? `Get a free key at https://aistudio.google.com/apikey → export GEMINI_API_KEY=your-key`
      : `Set ${envVar} in your environment`;
    throw new Error(`No API key found for "${name}". ${hint}`);
  }
  return key;
}

const DEFAULT_CONSENSUS_PROVIDERS: ProviderName[] = ['gemini', 'openai', 'claude'];

/**
 * Build the consensus rig: a provider-agnostic Retriever plus the named
 * providers to fan out to. A provider whose API key is missing is SKIPPED here
 * rather than throwing — a missing key must not abort a consensus scan (it
 * simply means one fewer voter). The Retriever defaults to gemini grounding but
 * is selected behind the Retriever interface so a different backend can be
 * swapped in by config.
 */
function buildConsensusRig(names: ProviderName[]): {
  retriever: Retriever;
  namedProviders: NamedProvider[];
} {
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
  // Retriever uses the gemini key (the grounding backend). If gemini has no key,
  // retrieval yields [] and providers judge from parametric knowledge.
  let retrieverKey = '';
  try {
    retrieverKey = resolveApiKey('gemini');
  } catch {
    retrieverKey = '';
  }
  return { retriever: new GeminiGroundingRetriever(retrieverKey), namedProviders };
}

export async function scan(
  text: string,
  providerName?: string,
  minConfidence?: number,
  ruleNames?: string[],
  onProgress?: ScanProgressCallback,
  onClaimVerified?: ScanClaimCallback,
  pipelineConfig?: PipelineConfig,
): Promise<ScanResult> {
  const resolvedProvider = providerName || 'gemini';

  // FR-3: per-stage provider names (fall back to resolvedProvider if not specified)
  const extractionName = pipelineConfig?.extractionProvider ?? resolvedProvider;
  const verificationName = pipelineConfig?.verificationProvider ?? resolvedProvider;

  const extractionApiKey = resolveApiKey(extractionName);
  const verificationApiKey = resolveApiKey(verificationName);

  const extractionProvider: LLMProvider = getProvider(extractionApiKey, extractionName);
  // Reuse the same instance when both stages use the same provider
  const verificationProvider: LLMProvider = extractionName === verificationName
    ? extractionProvider
    : getProvider(verificationApiKey, verificationName);

  // Consensus mode (opt-in, additive). When off, the rig is never built and the
  // single-provider verify path below runs unchanged.
  const consensusEnabled = pipelineConfig?.consensus === true;
  const consensusRig = consensusEnabled
    ? buildConsensusRig(pipelineConfig?.consensusProviders ?? DEFAULT_CONSENSUS_PROVIDERS)
    : null;

  onProgress?.('Extracting claims...');
  const rawClaims = await extractionProvider.extractClaims(text);
  const claims = guaranteeClaimPerSentence(text, rawClaims);
  const toVerify = filterClaimsForVerification(claims);

  const verifications: Record<string, VerificationResult> = {};
  let completedCount = 0;
  let cursor = 0;
  const runSlot = async (): Promise<void> => {
    while (cursor < toVerify.length) {
      const i = cursor++;
      onProgress?.(`Verifying claim ${i + 1}/${toVerify.length}...`);
      let result: VerificationResult;

      // Consensus branch: fan out to N providers over shared retrieved sources.
      // consensusVerify is internally resilient (never throws), so it bypasses
      // the single-provider retry ladder.
      if (consensusRig) {
        result = await consensusVerify(toVerify[i], consensusRig.retriever, consensusRig.namedProviders);
        verifications[toVerify[i].id] = result;
        completedCount++;
        onClaimVerified?.(toVerify[i], result, i, toVerify.length);
        continue;
      }

      let delay = 1000;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await verificationProvider.verifyClaim(toVerify[i]);
          break;
        } catch (err) {
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, delay + Math.floor(Math.random() * 500)));
            delay *= 2;
          } else {
            const isRateLimit = err instanceof Error && (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'));
            result = { claimId: toVerify[i].id, status: 'unverified', explanation: isRateLimit ? 'Rate limit reached. Upgrade for higher limits: https://faultline.nxtg.ai/pricing' : 'Verify failed after retries.', sources: [] };
          }
        }
      }
      verifications[toVerify[i].id] = result!;
      completedCount++;
      onClaimVerified?.(toVerify[i], result!, i, toVerify.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, toVerify.length) }, runSlot));

  onProgress?.('Generating report...');
  const overallRisk = calculateRisk(verifications);
  const complianceReport = generateComplianceReport(toVerify, verifications, overallRisk, minConfidence);

  const ruleFindings = ruleNames
    ? runRules(text, ruleNames)
    : runAllRules(text);

  const verificationErrors = Object.values(verifications).filter((v) => v.apiError).length;

  return {
    input: text.substring(0, 200),
    provider: extractionProvider.name,
    claims,
    verifications,
    overallRisk,
    complianceReport,
    ruleFindings,
    verificationErrors,
    degraded: verificationErrors > 0,
  };
}

// --- Batch scanning ---

export interface BatchScanResult {
  directory: string;
  glob: string | null;
  filesScanned: number;
  filesSkipped: number;
  results: Array<{ file: string; result: ScanResult }>;
  summary: BatchSummary;
}

export interface BatchSummary {
  totalClaims: number;
  totalVerifications: number;
  riskCounts: Record<AnalysisState['overallRisk'], number>;
  highestRisk: AnalysisState['overallRisk'];
  euTierCounts: { unacceptable: number; high: number; limited: number; minimal: number };
}

/**
 * Recursively collect files from a directory.
 */
function collectFiles(dir: string, globPattern: string | null): string[] {
  const files: string[] = [];
  const matcher = globPattern ? globToRegex(globPattern) : null;

  function walk(current: string) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden dirs and node_modules
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (matcher) {
          if (matcher.test(entry.name)) files.push(fullPath);
        } else {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files.sort();
}

/**
 * Convert a simple glob pattern (e.g. "*.py", "*.txt") to a RegExp.
 * Supports * and ? wildcards.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Scan all files in a directory, optionally filtered by glob.
 */
export async function batchScan(
  dir: string,
  providerName?: string,
  minConfidence?: number,
  globPattern?: string,
): Promise<BatchScanResult> {
  const files = collectFiles(dir, globPattern || null);
  const results: Array<{ file: string; result: ScanResult }> = [];
  let filesSkipped = 0;

  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf-8').trim();
      if (!text) {
        filesSkipped++;
        continue;
      }
      const result = await scan(text, providerName, minConfidence);
      results.push({ file: relative(dir, file), result });
    } catch {
      filesSkipped++;
    }
  }

  const summary = aggregateResults(results.map(r => r.result));

  return {
    directory: dir,
    glob: globPattern || null,
    filesScanned: results.length,
    filesSkipped,
    results,
    summary,
  };
}

function aggregateResults(results: ScanResult[]): BatchSummary {
  const riskCounts: Record<AnalysisState['overallRisk'], number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  const euTierCounts = { unacceptable: 0, high: 0, limited: 0, minimal: 0 };
  let totalClaims = 0;
  let totalVerifications = 0;

  for (const r of results) {
    totalClaims += r.claims.length;
    totalVerifications += Object.keys(r.verifications).length;
    riskCounts[r.overallRisk]++;

    const eu = r.complianceReport.euRiskSummary;
    euTierCounts.unacceptable += eu.unacceptable;
    euTierCounts.high += eu.high;
    euTierCounts.limited += eu.limited;
    euTierCounts.minimal += eu.minimal;
  }

  const riskOrder: AnalysisState['overallRisk'][] = ['critical', 'high', 'medium', 'low'];
  const highestRisk = riskOrder.find(r => riskCounts[r] > 0) || 'low';

  return { totalClaims, totalVerifications, riskCounts, highestRisk, euTierCounts };
}
