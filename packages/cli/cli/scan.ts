import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Claim, VerificationResult, AnalysisState } from '../types.js';
import { generateComplianceReport, type ComplianceReport } from '../compliance/report_generator.js';
import { runAllRules, runRules, type Finding } from '../rules/index.js';
import { isExtractionError, type ExtractionErrorReason } from '../providers/extraction-error.js';
import {
  DEFAULT_VERIFY_CAP,
  resolveVerifyCap,
  rankEligibleClaims,
  buildVerificationSummary,
  type VerificationSummary,
} from './verify-cap.js';
import {
  resolveScanProviders,
  resolveExtractionProvider,
  resolveVerifier,
  runVerification,
  type PipelineConfig,
  type ScanProgressCallback,
  type ScanClaimCallback,
  type Verifier,
} from './verify-runner.js';
import {
  partitionForFullScan,
  unitsForFullScan,
  buildFullVerificationSummary,
  type FullVerificationSummary,
  type ScanMode,
} from './full-scan.js';

export { DEFAULT_VERIFY_CAP, resolveVerifyCap, type VerificationSummary };
export {
  VERIFY_CONCURRENCY,
  resolveVerifyConcurrency,
  type ProviderName,
  type PipelineConfig,
  type ScanProgressCallback,
  type ScanClaimCallback,
} from './verify-runner.js';
export {
  CLAIMS_PER_UNIT,
  unitsForFullScan,
  unitAccounting,
  partitionForFullScan,
  type FullVerificationSummary,
  type ScanMode,
  type UnitAccounting,
} from './full-scan.js';

/**
 * Server-side scan options. Deliberately separate from PipelineConfig, which
 * the API accepts from the request body: nothing here may come from a caller.
 */
export interface ScanOptions {
  /**
   * Maximum claims sent to verification (default DEFAULT_VERIFY_CAP = 8).
   * Normalised by resolveVerifyCap, so an invalid value falls back to 8.
   * Ignored in `full` mode.
   */
  verifyCap?: number;
  /**
   * `quick` (default): verify the top `verifyCap` facts of importance >= 2.
   * `full`: verify every fact claim, any importance, in extraction order, and
   * report opinions and interpretations as not checkable. Any value other than
   * 'full' runs quick, so a bad value can never lift the cost bound.
   */
  mode?: ScanMode;
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
  /**
   * What the verify stage did to this scan. Quick mode: what the cap left
   * unchecked (VerificationSummary, no `mode` field). Full mode: the
   * FullVerificationSummary (`mode: 'full'`). scan() always sets it; it is
   * optional because results read back from history files or an older hosted
   * API do not carry it.
   */
  verification?: VerificationSummary | FullVerificationSummary;
}

/** The result of a full scan run: a ScanResult with the full-mode summary. */
export interface FullScanResult extends ScanResult {
  verification: FullVerificationSummary;
  /** Fact claims never started because the run was stopped (same as verification.uncheckedClaimIds). */
  notAttemptedClaimIds: string[];
}

/** The estimate of a full scan: extraction only, no verification. */
export interface FullScanEstimate {
  /** The claims a full scan of this text checks, after the per-sentence guarantee. */
  claims: Claim[];
  /** Claims of type `fact`: the ones that will be verified. */
  factClaims: number;
  /** Opinions and interpretations: reported as not checkable. */
  notCheckable: number;
  /** Units charged: ceil(factClaims / CLAIMS_PER_UNIT), 0 when there are no facts. */
  units: number;
}

/** Options for verifyFullScan. */
export interface VerifyFullScanOptions {
  providerName?: string;
  pipelineConfig?: PipelineConfig;
  /** Fired once per verified fact claim, with its index among the facts and the fact total. */
  onClaim?: ScanClaimCallback;
  onProgress?: ScanProgressCallback;
  /** Stops starting new claims; claims never started are reported as not attempted. */
  signal?: AbortSignal;
  /** Fact claims verified at the same time (default VERIFY_CONCURRENCY, 8). The API's full scan uses 4. */
  concurrency?: number;
  /** The scanned text, when available: sets `input` and runs the local rules (no provider call). */
  text?: string;
  minConfidence?: number;
  ruleNames?: string[];
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
 * Words that end in a period without ending a sentence: case captions ("Park v. Kim"),
 * reporters and courts ("F. Supp.", "9th Cir."), company suffixes, titles, months.
 * Splitting at them cut "...in Delmont v. Arcadia Freight Systems, Inc., 947 F.3d 1182
 * (9th Cir. 2020), holding..." into fragments, and the fragment naming only "Delmont v."
 * was then verified on its own and came back SUPPORTED against an unrelated case
 * (ce proof run, al:4e0038613d2563e1, 2026-10-12).
 */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  'v', 'vs', 'inc', 'corp', 'co', 'ltd', 'llc', 'llp', 'plc', 'cir', 'fed', 'supp', 'app', 'cal', 'ct',
  'no', 'nos', 'cf', 'al', 'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'gen', 'gov', 'sen', 'rep',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'dept', 'univ', 'vol', 'pp', 'para', 'art', 'sec', 'ch', 'fig', 'approx',
]);

/** True when the text ending in `lastWord` + punctuation really ends a sentence before `next`. */
function isSentenceBoundary(lastWord: string, punct: string, next: string): boolean {
  // A sentence starts with a capital letter (or a quote/bracket before one). A lower-case
  // word or a digit after the period continues the sentence ("Cir. 2020)").
  if (!/^[A-Z]/.test(next)) return false;
  if (!punct.startsWith('.')) return true;
  const word = lastWord.replace(/^[("'\[\u201c\u2018]+/, '');
  if (/^[A-Z]$/.test(word)) return false;                    // an initial: "John F. Kennedy"
  if (/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(word)) return false;  // "U.S", "e.g", "i.e"
  return !NON_TERMINAL_ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Split text into independently verifiable sentence candidates.
 * Filters out fragments shorter than 3 words (not verifiable on their own).
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const boundary = /([.!?]+)(["'\)\]\u201d\u2019]*)\s+(["'\(\[\u201c\u2018]*)(\S?)/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) {
    const head = text.slice(start, m.index);
    const lastWord = head.slice(head.search(/\S+$/) >= 0 ? head.search(/\S+$/) : head.length);
    if (!isSentenceBoundary(lastWord, m[1]!, m[4] ?? '')) {
      boundary.lastIndex = m.index + m[1]!.length; // keep scanning past this period
      continue;
    }
    const end = m.index + m[1]!.length + m[2]!.length;
    sentences.push(text.slice(start, end));
    start = end;
    boundary.lastIndex = end;
  }
  sentences.push(text.slice(start));
  return sentences
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

/**
 * Pick the claims to verify: facts of importance >= 2, most important first,
 * at most `cap` of them. An invalid cap falls back to DEFAULT_VERIFY_CAP.
 */
export function filterClaimsForVerification(claims: Claim[], cap: number = DEFAULT_VERIFY_CAP): Claim[] {
  return rankEligibleClaims(claims).slice(0, resolveVerifyCap(cap));
}

/** Rule findings for the scanned text (local pattern rules, no provider call). */
function findRules(text: string, ruleNames?: string[]): Finding[] {
  return ruleNames ? runRules(text, ruleNames) : runAllRules(text);
}

/** Count of verifications that ran into a provider/API error instead of a verdict. */
function countVerificationErrors(verifications: Record<string, VerificationResult>): number {
  return Object.values(verifications).filter((v) => v.apiError).length;
}

export async function scan(
  text: string,
  providerName?: string,
  minConfidence?: number,
  ruleNames?: string[],
  onProgress?: ScanProgressCallback,
  onClaimVerified?: ScanClaimCallback,
  pipelineConfig?: PipelineConfig,
  options?: ScanOptions,
): Promise<ScanResult> {
  const { extractionProvider, verifier } = resolveScanProviders(providerName, pipelineConfig);

  onProgress?.('Extracting claims...');
  const rawClaims = await extractionProvider.extractClaims(text);
  const claims = guaranteeClaimPerSentence(text, rawClaims);

  if (options?.mode === 'full') {
    return runFullVerification(claims, verifier, {
      provider: extractionProvider.name, text, minConfidence, ruleNames, onProgress, onClaim: onClaimVerified,
    });
  }

  const verifyCap = resolveVerifyCap(options?.verifyCap);
  const rankedEligible = rankEligibleClaims(claims);
  const toVerify = rankedEligible.slice(0, verifyCap);
  const { verifications } = await runVerification(toVerify, verifier, { onProgress, onClaimVerified });

  onProgress?.('Generating report...');
  const overallRisk = calculateRisk(verifications);
  const complianceReport = generateComplianceReport(toVerify, verifications, overallRisk, minConfidence);
  const verificationErrors = countVerificationErrors(verifications);

  return {
    input: text.substring(0, 200),
    provider: extractionProvider.name,
    claims,
    verifications,
    overallRisk,
    complianceReport,
    ruleFindings: findRules(text, ruleNames),
    verificationErrors,
    degraded: verificationErrors > 0,
    verification: buildVerificationSummary(rankedEligible, toVerify, verifyCap),
  };
}

// --- Full scan ---

/**
 * Extract the claims a full scan would check and price it, without verifying.
 * Makes one extraction call and no verify or grounding call.
 *
 * @example
 *   const est = await extractForFullScan(text, 'gemini');
 *   // est.units === Math.ceil(est.factClaims / 8)
 */
export async function extractForFullScan(
  text: string,
  providerName?: string,
  pipelineConfig?: PipelineConfig,
): Promise<FullScanEstimate> {
  const extractionProvider = resolveExtractionProvider(providerName, pipelineConfig);
  const claims = guaranteeClaimPerSentence(text, await extractionProvider.extractClaims(text));
  const { facts, notCheckable } = partitionForFullScan(claims);
  return {
    claims,
    factClaims: facts.length,
    notCheckable: notCheckable.length,
    units: unitsForFullScan(facts.length),
  };
}

/**
 * Verify every fact claim in `claims` (typically from extractForFullScan), with
 * no second extraction, so the run checks exactly the claims the estimate priced.
 * Opinions and interpretations are reported as not checkable, never verified.
 */
export async function verifyFullScan(
  claims: Claim[],
  opts: VerifyFullScanOptions = {},
): Promise<FullScanResult> {
  const verifier = resolveVerifier(opts.providerName, opts.pipelineConfig);
  return runFullVerification(claims, verifier, { ...opts, provider: verifier.provider.name });
}

interface FullVerificationContext {
  provider: string;
  text?: string;
  minConfidence?: number;
  ruleNames?: string[];
  onProgress?: ScanProgressCallback;
  onClaim?: ScanClaimCallback;
  signal?: AbortSignal;
  concurrency?: number;
}

/** The full-scan core shared by scan(mode 'full') and verifyFullScan. */
async function runFullVerification(
  claims: Claim[],
  verifier: Verifier,
  context: FullVerificationContext,
): Promise<FullScanResult> {
  const partition = partitionForFullScan(claims);
  const run = await runVerification(partition.facts, verifier, {
    onProgress: context.onProgress,
    onClaimVerified: context.onClaim,
    signal: context.signal,
    concurrency: context.concurrency,
    flagExhaustedRetries: true,
  });

  context.onProgress?.('Generating report...');
  const overallRisk = calculateRisk(run.verifications);
  const complianceReport = generateComplianceReport(run.attempted, run.verifications, overallRisk, context.minConfidence);
  const verification = buildFullVerificationSummary(partition, run.results);
  // Positional, like the summary: an id-keyed count would lose a failure behind a duplicate id.
  const verificationErrors = verification.unservedClaimIds.length;

  return {
    input: context.text?.substring(0, 200) ?? '',
    provider: context.provider,
    claims,
    verifications: run.verifications,
    overallRisk,
    complianceReport,
    ruleFindings: context.text !== undefined ? findRules(context.text, context.ruleNames) : [],
    verificationErrors,
    degraded: verificationErrors > 0,
    verification,
    notAttemptedClaimIds: verification.uncheckedClaimIds,
  };
}

// --- Batch scanning ---

export interface BatchScanResult {
  directory: string;
  glob: string | null;
  filesScanned: number;
  filesSkipped: number;
  /** Files counted in filesSkipped because claim extraction failed: nothing in them was checked. */
  extractionFailures: Array<{ file: string; reason: ExtractionErrorReason }>;
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
  const extractionFailures: BatchScanResult['extractionFailures'] = [];
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
    } catch (err) {
      filesSkipped++;
      if (isExtractionError(err)) extractionFailures.push({ file: relative(dir, file), reason: err.reason });
    }
  }

  const summary = aggregateResults(results.map(r => r.result));

  return {
    directory: dir,
    glob: globPattern || null,
    filesScanned: results.length,
    filesSkipped,
    extractionFailures,
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
