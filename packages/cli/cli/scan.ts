import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Claim, VerificationResult, AnalysisState } from '../types.js';
import type { LLMProvider } from '../providers/base_provider.js';
import { getProvider } from '../providers/registry.js';
import { generateComplianceReport, type ComplianceReport } from '../compliance/report_generator.js';
import { runAllRules, runRules, type Finding } from '../rules/index.js';

export interface ScanResult {
  input: string;
  provider: string;
  claims: Claim[];
  verifications: Record<string, VerificationResult>;
  overallRisk: AnalysisState['overallRisk'];
  complianceReport: ComplianceReport;
  ruleFindings: Finding[];
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

function filterClaimsForVerification(claims: Claim[]): Claim[] {
  return claims
    .filter((c) => c.type === 'fact' && c.importance >= 3)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 8);
}

/** Callback for reporting scan progress to the caller (e.g., a CLI spinner). */
export type ScanProgressCallback = (message: string) => void;

export async function scan(text: string, providerName?: string, minConfidence?: number, ruleNames?: string[], onProgress?: ScanProgressCallback): Promise<ScanResult> {
  const resolvedProvider = providerName || 'gemini';

  let apiKey = '';
  if (resolvedProvider !== 'mock') {
    const keyMap: Record<string, string> = {
      claude: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
      perplexity: 'PERPLEXITY_API_KEY',
    };
    const envVar = keyMap[resolvedProvider] || 'GEMINI_API_KEY';
    apiKey = process.env[envVar] || '';

    if (!apiKey) {
      const hint = resolvedProvider === 'gemini'
        ? `Get a free key at https://aistudio.google.com/apikey → export GEMINI_API_KEY=your-key`
        : `Set ${envVar} in your environment`;
      throw new Error(`No API key found for "${resolvedProvider}". ${hint}`);
    }
  }

  const provider: LLMProvider = getProvider(apiKey, resolvedProvider);

  onProgress?.('Extracting claims...');
  const rawClaims = await provider.extractClaims(text);
  const claims = guaranteeClaimPerSentence(text, rawClaims);
  const toVerify = filterClaimsForVerification(claims);

  const verifications: Record<string, VerificationResult> = {};
  for (let i = 0; i < toVerify.length; i++) {
    onProgress?.(`Verifying claim ${i + 1}/${toVerify.length}...`);
    verifications[toVerify[i].id] = await provider.verifyClaim(toVerify[i]);
  }

  onProgress?.('Generating report...');
  const overallRisk = calculateRisk(verifications);
  const complianceReport = generateComplianceReport(toVerify, verifications, overallRisk, minConfidence);

  const ruleFindings = ruleNames
    ? runRules(text, ruleNames)
    : runAllRules(text);

  return {
    input: text.substring(0, 200),
    provider: provider.name,
    claims,
    verifications,
    overallRisk,
    complianceReport,
    ruleFindings,
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
