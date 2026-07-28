#!/usr/bin/env npx tsx
/**
 * Faultline CLI — scan text, generate compliance reports.
 *
 * Usage:
 *   npx tsx cli/index.ts scan --input <file> [--provider gemini|claude|openai|mock]
 *   npx tsx cli/index.ts report --input <results.json>
 *   npx tsx cli/index.ts version
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { scan, batchScan } from './scan.js';
import { renderReport, renderReportAs, type OutputFormat, type SarifOptions } from './report.js';
import { listRules, getRule } from '../rules/index.js';
import { loadConfig, mergeFlags, generateSampleConfig, getLocalTemplate, addPluginToConfig, removePluginFromConfig } from './config.js';
import { loadPlugin, loadPluginsFromConfig, getLoadedPlugins } from '../plugins/loader.js';
import { startWatch } from './watch.js';
import { getAllTemplates, getTemplatesByCategories, listCategories, validateCategories, type TemplateCategory } from '../templates/index.js';
import { checkThreshold, countFromScanResult, type SeverityLevel } from './action.js';
import { aggregate, renderAggregatedReport, type AggregateOutputFormat } from './aggregate.js';
import { saveHistoryEntry, listHistory, analyzeTrend, formatHistoryList, formatTrendAnalysis } from '../history/store.js';
import { analyzeWeakestLinks } from '../analysis/weakest-link.js';
import { formatWeakestLinkAnalysis } from './weakest.js';
import { buildClaimGraph, renderMermaid, renderDot } from '../analysis/claim-graph.js';
import { extractFailedClaims, buildCritiqueAnalysis } from '../analysis/critique.js';
import { formatCritique } from './critique.js';
import { createScanSpinner } from './spinner.js';
import { compareScanResults, renderCompare } from './compare.js';
import { render as renderExport, applyFilter, type ExportFormat } from './export.js';
import { setLang } from '../lib/i18n.js';
import { getDemoResult } from './demo.js';
import { listKeys, getDormantKeys, getExpiringSoonKeys, rotateKey, getRotationStatus, getKeysPrunePreview, pruneKeys, formatKeyList, formatDormantList, formatExpiringSoonList, formatRotateResult, formatRotationStatus, formatPrunePreview, formatPruneResult } from './keys-client.js';
import { getStaleScans, getScanUsage, getScansPrunePreview, pruneScans, formatStaleList, formatScanUsage, formatScansPrunePreview, formatScansPruneResult } from './scans-client.js';
import { streamScan, formatStreamResult } from './stream-client.js';
import { buildEuComplianceReport, renderComplianceReportJson, renderComplianceReportPdf, renderComplianceReportMarkdown, renderComplianceReportSarif, renderComplianceReportHtml, evaluateComplianceGate, renderCiGateOutput, diffComplianceReports, renderComplianceDiffOutput, loadComplianceConfig } from './compliance-report.js';
import { statsCommand } from './stats.js';
import { sendTelemetry, classifyError } from './telemetry.js';
import { printConversionNudge } from './nudge.js';
import { governCommand } from './govern.js';
import { evaluateGuard, formatGuardReport, formatGuardJson, readStdin, isFailOn, FAIL_ON_VALUES } from './guard.js';
import { resolveTransport, runScan, isGrounded } from './transport.js';

/**
 * Read from package.json rather than hardcoded.
 *
 * A hardcoded copy drifts silently: 0.9.1 shipped to npm with this constant
 * still reading '0.8.0', so `faultline version` misreported the tool, and that
 * wrong version was stamped into telemetry and compliance reports — artefacts
 * whose entire purpose is to say which tool produced them. The version-parity
 * gate could not catch it either, because it compares manifests and the
 * deployed API, never the binary's own output.
 */
const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0-unknown';
  }
})();
const PRICING_URL = 'https://faultline.nxtg.ai/pricing';

/** Print once per invocation to stderr. Silenced by FAULTLINE_NO_BANNER=1 or test env. */
function printUpgradeBanner(): void {
  if (process.env.FAULTLINE_NO_BANNER === '1') return;
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  process.stderr.write(`→ More scans, batch processing & team workspaces: ${PRICING_URL}\n`);
}

const API_KEY_MAP: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
};

/**
 * Auto-detect which provider to use based on env vars.
 * Priority: gemini -> openai -> claude -> perplexity -> mock
 */
function autoDetectProvider(): string {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.PERPLEXITY_API_KEY) return 'perplexity';
  return 'mock';
}

function checkApiKey(providerName: string | undefined): { exitCode: number; output: string } | null {
  const resolved = providerName || 'gemini';
  if (resolved === 'mock') return null;
  const envVar = API_KEY_MAP[resolved] || 'GEMINI_API_KEY';
  if (process.env[envVar]) return null;
  const hint = resolved === 'gemini'
    ? `Get a free Gemini key at https://aistudio.google.com/apikey\n  Then: export GEMINI_API_KEY=your-key`
    : `Set ${envVar} in your environment`;
  return { exitCode: 1, output: `No API key found for provider "${resolved}".\n\n  ${hint}\n\nFor CI/testing without an API key: --provider mock` };
}

/**
 * Fail a `--fail-on` gate CLOSED when the scan was degraded.
 *
 * A degraded scan (transient provider errors — 429/503/network — left one or more
 * claims unverified; see `ScanResult.degraded`) did NOT actually check every claim.
 * A verification gate that returns exit 0 in that state would let an unchecked —
 * possibly fabricated — claim pass as "clean", the precise failure this tool exists
 * to prevent. Commit 957439a stopped degraded results masquerading in the display
 * layer; this closes the same hole in the exit-code/gate layer. The gate fails
 * closed.
 *
 * The diagnostic goes to STDERR so machine-readable stdout (the `--output-format
 * json` consumed by CI gates) stays parseable. Returns a non-zero result for the
 * caller to short-circuit on, or `null` when the scan was not degraded.
 */
function degradedGateFailure(
  isDegraded: boolean,
  output: string,
): { exitCode: number; output: string } | null {
  if (!isDegraded) return null;
  process.stderr.write(
    '✗ Faultline gate FAILED: verification was degraded — transient provider errors ' +
    'left claims unverified, so the result cannot be trusted. Re-run when the provider ' +
    'is healthy. (--fail-on fails closed on degraded scans.)\n',
  );
  return { exitCode: 1, output };
}

function usage(): string {
  return `Faultline CLI v${VERSION} — AI Claim Forensics

Quick start (free Gemini key: https://aistudio.google.com/apikey):
  export GEMINI_API_KEY="your-key"
  faultline scan --input doc.txt --provider gemini

Example output:
  === FAULTLINE COMPLIANCE REPORT ===
  Provider:     Google Gemini
  Overall Risk: HIGH
  --- Claim Verifications ---
    [OK] c1: supported — Confirmed by census data. (confidence: 0.82)
    [!!] c2: contradicted — Audit found significant bias. (confidence: 0.91)
    [??] c3: mixed — Evidence varies by region. (confidence: 0.63)
  --- Triggered EU AI Act Articles ---
    Annex III §4: Employment and recruitment AI (affects: c2)

Usage:
  <agent output> | faultline guard [--fail-on refuted|unsupported] [--json] [--provider gemini]   Check piped text; advisory unless --fail-on
  faultline scan --demo                                               Run interactive demo (no API key required)
  faultline scan --input <file> [--provider gemini|claude|openai|perplexity|mock] [--min-confidence 0.0-1.0] [--output-format json|markdown|html|sarif] [--sarif] [--rules pii,bias,toxicity] [--fail-on critical|high|medium|low]
  faultline scan --dir <path> [--glob "*.txt"] [--provider gemini] [--output-format sarif] [--fail-on high]
  faultline aggregate --dir <path> [--output-format json|markdown|html|sarif]  Aggregate scan results
  faultline report --input <results.json> [--output-format json|markdown|html|sarif]
  faultline watch --dir <path> [--provider gemini] [--output-format json]   Watch for changes
  faultline scan --templates injection,bias                         Red-team scan with template categories
  faultline scan --template compliance-check                        Use named template from .faultlinerc.json
  faultline templates list [--category injection]                   List red-team prompt templates
  faultline history [--all] [--history-dir <path>]                  List past scans
  faultline trend --file <path> [--history-dir <path>]             Show finding trend for a file
  faultline weakest --input <file> [--provider gemini] [--top N]       Identify the weakest-link claim
  faultline graph --input <file> [--format mermaid|dot]             Export claim graph
  faultline critique --input <file> [--provider gemini]             Critique failed claims + improved prompt
  faultline compare --before <text|file> --after <text|file> [--provider mock]   Compare two scans side-by-side
  faultline export [--format csv|json|ndjson] [--from ISO_DATE] [--to ISO_DATE] [--provider gemini] [--risk high] [--output file.csv]
  faultline plugin install <pkg>                                    Install a plugin (npm install + register)
  faultline plugin remove  <pkg>                                    Remove a plugin
  faultline plugin list                                             List loaded plugins
  faultline rules                                                   List available rules
  faultline init                                                    Generate .faultlinerc.json
  faultline keys list [--api-url URL] [--api-key KEY]              List all API keys
  faultline keys dormant [--days 30] [--api-url URL] [--api-key KEY]  List dormant keys
  faultline keys expiring [--days 7] [--api-url URL] [--api-key KEY]  List keys expiring soon
  faultline keys rotate <id> [--api-url URL] [--api-key KEY]       Rotate an API key
  faultline scans stale [--days 30] [--api-url URL] [--api-key KEY]  List stale scan groups
  faultline scans usage [--staleDays 30] [--api-url URL] [--api-key KEY]  Scan usage analytics
  faultline scans prune [--days 30] [--confirm] [--api-url URL] [--api-key KEY]  Delete stale scan groups
  faultline stats [--costs] [--api-url URL] [--api-key KEY]        Show npm stats or managed-key scan cost percentiles
  faultline compliance-report --input <scan.json> [--format json|pdf|markdown|sarif|html] [--output <file>] [--project-name "My AI"]  Generate EU AI Act Article 9/13/50 evidence report
  faultline compliance-report --text <text> --provider mock [--format json|pdf|markdown|sarif|html] [--project-name "My AI"]  Scan then report
  faultline compliance-report --input <scan.json> --ci                 CI gate: exit 1 on non-compliant articles or high/critical risk
  faultline compliance-report --diff before.json,after.json            Compare two compliance reports — show improved/regressed articles
  faultline stream <text> [--provider mock] [--api-url URL] [--api-key KEY]  Stream scan via SSE
  faultline version                                                 Print version

Config:
  Reads .faultlinerc.json from cwd (walks up). CLI flags override config values.

Environment:
  FAULTLINE_API_KEY    Hosted API key — scans run on our servers, no provider key needed
  FAULTLINE_API_URL    Hosted API base URL (default: https://faultline-api.fly.dev)
  GEMINI_API_KEY       API key for Gemini provider (free: https://aistudio.google.com/apikey)
  ANTHROPIC_API_KEY    API key for Claude provider
  OPENAI_API_KEY       API key for OpenAI provider
  PERPLEXITY_API_KEY   API key for Perplexity provider
  FAULTLINE_PROVIDER   Default provider (gemini|claude|openai|perplexity)

For CI/testing without an API key, use --provider mock (returns synthetic results).`;
}

// Boolean flags that take no value argument
const BOOLEAN_FLAGS = new Set(['sarif', 'all', 'demo', 'confirm', 'ci', 'strict', 'costs', 'no-save', 'no-nudge', 'json']);

function parseArgs(args: string[]): { command: string; flags: Record<string, string> } {
  const command = args[0] || '';
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = 'true';
      } else if (i + 1 < args.length) {
        flags[key] = args[i + 1];
        i++;
      }
    }
  }

  return { command, flags };
}

export async function main(args: string[]): Promise<{ exitCode: number; output: string }> {
  const { command, flags } = parseArgs(args);
  setLang(flags['lang'] || 'en');

  // Print upgrade banner for scan commands (not version/help/demo to avoid noise)
  if (command === 'scan' || command === 'stream') {
    printUpgradeBanner();
  }

  switch (command) {
    case 'version':
    case '--version':
    case '-v':
      return { exitCode: 0, output: `Faultline v${VERSION}` };

    case 'stats': {
      // N-214: npm download metrics — fetch last-week counts, persist snapshot, show trend
      // DIRECTIVE-NXTG-20260506-04: --costs flag → managed-key scan cost percentiles
      const costs = Boolean(flags['costs']);
      if (costs) {
        const apiUrl = flags['api-url'] as string | undefined;
        const apiKey = flags['api-key'] as string | undefined;
        return statsCommand({ costs: true, apiUrl, apiKey });
      }
      const pkgs = flags['package']
        ? (Array.isArray(flags['package']) ? flags['package'] : [flags['package']])
        : undefined;
      const snapshotPath = flags['snapshot-path'] as string | undefined;
      const noSave = Boolean(flags['no-save']);
      return statsCommand({ packages: pkgs as string[] | undefined, snapshotPath, noSave });
    }

    case 'help':
    case '--help':
    case '-h':
      return { exitCode: 0, output: usage() };

    case 'plugin': {
      const sub = args[1]; // install | remove | list
      const pkgArg = args[2];

      if (sub === 'list') {
        // Auto-load config plugins so the list is accurate
        const cfg = loadConfig();
        if (cfg.plugins?.length) {
          await loadPluginsFromConfig(cfg.plugins);
        }
        const loaded = getLoadedPlugins();
        if (loaded.length === 0) {
          return { exitCode: 0, output: 'No plugins loaded. Install one with: faultline plugin install <package>' };
        }
        const lines = ['Loaded plugins:', ''];
        for (const p of loaded) {
          lines.push(`  ${p.plugin.name.padEnd(30)} ${p.plugin.version ?? ''}`);
          lines.push(`    package: ${p.packageName}`);
          lines.push(`    loaded:  ${p.loadedAt}`);
        }
        return { exitCode: 0, output: lines.join('\n') };
      }

      if (sub === 'install') {
        if (!pkgArg) {
          return { exitCode: 1, output: 'Usage: faultline plugin install <package-name>' };
        }

        // 1. npm install
        try {
          process.stderr.write(`Installing ${pkgArg}...\n`);
          execSync(`npm install ${pkgArg}`, { cwd: process.cwd(), stdio: 'inherit' });
        } catch {
          return { exitCode: 1, output: `Failed to install ${pkgArg}. Check the package name and your npm registry.` };
        }

        // 2. Add to .faultlinerc.json
        const configPath = addPluginToConfig(process.cwd(), pkgArg);

        // 3. Verify the plugin loads
        try {
          const loaded = await loadPlugin(pkgArg);
          return {
            exitCode: 0,
            output: [
              `Plugin installed: ${loaded.plugin.name}${loaded.plugin.version ? ` v${loaded.plugin.version}` : ''}`,
              `Package:  ${pkgArg}`,
              `Config:   ${configPath}`,
              '',
              'The plugin will be loaded automatically on every scan.',
            ].join('\n'),
          };
        } catch (err) {
          return {
            exitCode: 1,
            output: `Plugin installed via npm but failed to load: ${(err as Error).message}\n\nCheck the plugin's documentation.`,
          };
        }
      }

      if (sub === 'remove') {
        if (!pkgArg) {
          return { exitCode: 1, output: 'Usage: faultline plugin remove <package-name>' };
        }

        // Remove from config
        const configPath = removePluginFromConfig(process.cwd(), pkgArg);

        // npm uninstall (best-effort)
        try {
          execSync(`npm uninstall ${pkgArg}`, { cwd: process.cwd(), stdio: 'inherit' });
        } catch { /* ignore — might not be installed via npm */ }

        return {
          exitCode: 0,
          output: configPath
            ? `Plugin "${pkgArg}" removed from ${configPath}.`
            : `Plugin "${pkgArg}" was not found in .faultlinerc.json.`,
        };
      }

      return {
        exitCode: 1,
        output: 'Usage:\n  faultline plugin install <package>\n  faultline plugin remove <package>\n  faultline plugin list',
      };
    }

    case 'rules': {
      const rules = listRules();
      const lines = ['Available rules:', ''];
      for (const name of rules) {
        const rule = getRule(name);
        lines.push(`  ${rule.id.padEnd(12)} ${rule.name} — ${rule.description}`);
      }
      return { exitCode: 0, output: lines.join('\n') };
    }

    case 'govern': {
      // Agent-governance surface (A-260, Increment 1): deterministic action-gating.
      const subcommand = args[1] && !args[1].startsWith('--') ? args[1] : 'list';
      return governCommand(subcommand, flags);
    }

    case 'templates': {
      const subcommand = args[1] || 'list';
      if (subcommand !== 'list') {
        return { exitCode: 1, output: `Unknown templates subcommand: ${subcommand}. Usage: faultline templates list [--category <name>]` };
      }

      const categoryFilter = flags['category'];
      let templates = getAllTemplates();

      if (categoryFilter) {
        const unknown = validateCategories([categoryFilter]);
        if (unknown.length > 0) {
          return { exitCode: 1, output: `Error: Unknown category "${categoryFilter}". Available: ${listCategories().join(', ')}` };
        }
        templates = getTemplatesByCategories([categoryFilter as TemplateCategory]);
      }

      const lines = [`Red-team prompt templates (${templates.length}):`, ''];
      const categories = listCategories();
      for (const cat of categories) {
        const catTemplates = templates.filter(t => t.category === cat);
        if (catTemplates.length === 0) continue;
        lines.push(`  ${cat.toUpperCase()} (${catTemplates.length}):`);
        for (const t of catTemplates) {
          const sev = t.severity === 'critical' ? '[!!]' : t.severity === 'high' ? '[!]' : t.severity === 'medium' ? '[?]' : '[--]';
          lines.push(`    ${sev} ${t.id.padEnd(22)} ${t.prompt_text.substring(0, 70)}${t.prompt_text.length > 70 ? '...' : ''}`);
        }
        lines.push('');
      }
      return { exitCode: 0, output: lines.join('\n') };
    }

    case 'init': {
      const targetDir = flags['dir'] || process.cwd();
      const filePath = generateSampleConfig(targetDir);

      // Detect which providers are configured
      const configured: string[] = [];
      const unconfigured: string[] = [];
      for (const [provider, envVar] of Object.entries(API_KEY_MAP)) {
        if (process.env[envVar]) configured.push(provider);
        else unconfigured.push(provider);
      }

      const configuredStr = configured.length > 0
        ? configured.map(p => `  ✓ ${p}`).join('\n')
        : '  (none — set an API key to use a real provider)';

      const nextSteps = configured.length > 0
        ? `faultline scan --input your-file.txt  (auto-detects ${configured[0]})`
        : `export GEMINI_API_KEY=your-key  # Get free key: https://aistudio.google.com/apikey\nfaultline scan --input your-file.txt`;

      return {
        exitCode: 0,
        output: `Faultline initialized!\n\nConfig file: ${filePath}\n\nProviders configured:\n${configuredStr}\n\nNext steps:\n  ${nextSteps}\n\nTip: Run \`faultline demo\` to see example output without an API key.`,
      };
    }

    case 'watch': {
      const watchDir = flags['dir'];
      if (!watchDir) {
        return { exitCode: 1, output: 'Error: --dir <path> is required for watch mode.\n\n' + usage() };
      }

      const resolvedDir = resolve(watchDir);
      if (!existsSync(resolvedDir)) {
        return { exitCode: 1, output: `Error: Directory not found: ${resolvedDir}` };
      }
      try {
        if (!statSync(resolvedDir).isDirectory()) {
          return { exitCode: 1, output: `Error: Not a directory: ${resolvedDir}` };
        }
      } catch {
        return { exitCode: 1, output: `Error: Cannot read: ${resolvedDir}` };
      }

      const config = loadConfig();
      const { provider: providerName, minConfidence, outputFormat, ruleNames } = mergeFlags(config, flags);

      startWatch({
        dir: resolvedDir,
        provider: providerName,
        minConfidence,
        outputFormat,
        ruleNames,
      });

      return { exitCode: 0, output: `Watching ${resolvedDir} for changes... (Ctrl+C to stop)` };
    }

    case 'aggregate': {
      const aggDir = flags['dir'];
      if (!aggDir) {
        return { exitCode: 1, output: 'Error: --dir <path> is required for aggregate.\n\n' + usage() };
      }

      const resolvedAggDir = resolve(aggDir);
      if (!existsSync(resolvedAggDir)) {
        return { exitCode: 1, output: `Error: Directory not found: ${resolvedAggDir}` };
      }
      try {
        if (!statSync(resolvedAggDir).isDirectory()) {
          return { exitCode: 1, output: `Error: Not a directory: ${resolvedAggDir}` };
        }
      } catch {
        return { exitCode: 1, output: `Error: Cannot read: ${resolvedAggDir}` };
      }

      const aggFormat = (flags['output-format'] || 'json') as AggregateOutputFormat;
      if (!['json', 'markdown', 'html', 'sarif'].includes(aggFormat)) {
        return { exitCode: 1, output: 'Error: --output-format must be json, markdown, html, or sarif.' };
      }

      // Read all JSON files from directory
      const { readdirSync } = await import('node:fs');
      const jsonFiles = readdirSync(resolvedAggDir)
        .filter((f: string) => f.endsWith('.json'))
        .sort();

      if (jsonFiles.length === 0) {
        return { exitCode: 1, output: `Error: No JSON files found in ${resolvedAggDir}.` };
      }

      const fileResults: Array<{ file: string; result: import('./scan.js').ScanResult }> = [];
      for (const jsonFile of jsonFiles) {
        try {
          const content = readFileSync(resolve(resolvedAggDir, jsonFile), 'utf-8');
          const parsed = JSON.parse(content);
          // Basic shape validation: must have claims and verifications
          if (parsed && parsed.claims && parsed.verifications && parsed.complianceReport) {
            fileResults.push({ file: jsonFile, result: parsed });
          }
        } catch {
          // Skip invalid JSON files
        }
      }

      if (fileResults.length === 0) {
        return { exitCode: 1, output: `Error: No valid scan result files found in ${resolvedAggDir}.` };
      }

      const aggregated = aggregate(fileResults);
      const aggOutput = renderAggregatedReport(aggregated, aggFormat);
      return { exitCode: 0, output: aggOutput };
    }

    case 'history': {
      const historyDir = flags['history-dir'] || undefined;
      const showAll = flags['all'] === 'true';
      const entries = listHistory(historyDir, { all: showAll });
      return { exitCode: 0, output: formatHistoryList(entries) };
    }

    case 'trend': {
      const trendFile = flags['file'];
      if (!trendFile) {
        return { exitCode: 1, output: 'Error: --file <path> is required for trend analysis.\n\n' + usage() };
      }
      const historyDir = flags['history-dir'] || undefined;
      const trend = analyzeTrend(trendFile, historyDir);
      return { exitCode: 0, output: formatTrendAnalysis(trend) };
    }

    case 'weakest': {
      const inputPath = flags['input'];
      if (!inputPath) {
        return { exitCode: 1, output: 'Error: --input <file> is required for weakest-link analysis.\n\n' + usage() };
      }

      const resolvedWeak = resolve(inputPath);
      if (!existsSync(resolvedWeak)) {
        return { exitCode: 1, output: `Error: File not found: ${resolvedWeak}` };
      }

      const weakText = readFileSync(resolvedWeak, 'utf-8').trim();
      if (!weakText) {
        return { exitCode: 1, output: 'Error: Input file is empty.' };
      }

      const weakConfig = loadConfig();
      const { provider: weakProvider, minConfidence: weakMinConf } = mergeFlags(weakConfig, flags);

      const weakResult = await scan(weakText, weakProvider, weakMinConf);
      const topN = flags['top'] ? parseInt(flags['top'], 10) : 5;
      const weakAnalysis = analyzeWeakestLinks(weakResult.claims, weakResult.verifications, weakResult.complianceReport);

      return { exitCode: 0, output: formatWeakestLinkAnalysis(weakAnalysis, isNaN(topN) ? 5 : topN) };
    }

    case 'graph': {
      const inputPath = flags['input'];
      if (!inputPath) {
        return { exitCode: 1, output: 'Error: --input <file> is required for graph export.\n\n' + usage() };
      }

      const resolvedGraph = resolve(inputPath);
      if (!existsSync(resolvedGraph)) {
        return { exitCode: 1, output: `Error: File not found: ${resolvedGraph}` };
      }

      const graphText = readFileSync(resolvedGraph, 'utf-8').trim();
      if (!graphText) {
        return { exitCode: 1, output: 'Error: Input file is empty.' };
      }

      const graphFormat = (flags['format'] || 'mermaid') as 'mermaid' | 'dot';
      if (!['mermaid', 'dot'].includes(graphFormat)) {
        return { exitCode: 1, output: 'Error: --format must be mermaid or dot.' };
      }

      const graphConfig = loadConfig();
      const { provider: graphProvider, minConfidence: graphMinConf } = mergeFlags(graphConfig, flags);

      const graphResult = await scan(graphText, graphProvider, graphMinConf);
      const claimGraph = buildClaimGraph(graphResult.claims, graphResult.verifications, graphResult.complianceReport);

      const graphOutput = graphFormat === 'dot' ? renderDot(claimGraph) : renderMermaid(claimGraph);
      return { exitCode: 0, output: graphOutput };
    }

    case 'guard': {
      // Reads the agent's output from stdin. Everything human-readable goes to
      // stderr so stdout stays clean for `--json` consumers piping onward.
      const failOnRaw = flags['fail-on'];
      if (failOnRaw !== undefined && !isFailOn(failOnRaw)) {
        return {
          exitCode: 1,
          output: `Error: --fail-on must be one of ${FAIL_ON_VALUES.join('|')}. Got "${failOnRaw}".`,
        };
      }
      const failOn = failOnRaw as import('./guard.js').FailOn | undefined;

      const guardText = (await readStdin()).trim();
      if (!guardText) {
        return {
          exitCode: 1,
          output:
            'Error: guard reads the text to check from stdin, and nothing was piped in.\n\n' +
            '  Example:\n' +
            '    claude -p "summarise the release" | npx @nxtg/faultline guard --fail-on refuted\n' +
            '    cat report.md | npx @nxtg/faultline guard --json',
        };
      }

      const guardTransport = resolveTransport(process.env, flags['api-url']);
      const guardConfig = loadConfig();
      const { provider: guardProviderFlag } = mergeFlags(guardConfig, flags);

      // In hosted mode the server holds the provider keys, so no local key is
      // needed and the provider stays unset unless explicitly chosen. Locally
      // we resolve one the same way `scan` does.
      const guardProvider =
        guardTransport.mode === 'hosted'
          ? guardProviderFlag
          : guardProviderFlag || autoDetectProvider();

      if (guardTransport.mode === 'local' && guardProvider === 'mock') {
        process.stderr.write(
          'faultline guard: no provider key found — running the "mock" provider, which returns ' +
            'SYNTHETIC results and verifies nothing. Set GEMINI_API_KEY (free: ' +
            'https://aistudio.google.com/apikey), or FAULTLINE_API_KEY to use the hosted API.\n',
        );
      } else if (!isGrounded(guardProvider)) {
        process.stderr.write(
          `faultline guard: provider "${guardProvider}" does not retrieve sources — verdicts ` +
            'will carry no evidence. Use gemini for source-backed verification.\n',
        );
      }

      let guardResult;
      try {
        guardResult = await runScan(guardText, guardProvider, guardTransport);
      } catch (err) {
        // A transport failure is not a verdict. Say so, and fail closed only if
        // the caller asked for a gate.
        const detail = err instanceof Error ? err.message : String(err);
        return {
          exitCode: failOn ? 1 : 0,
          output:
            `faultline guard: verification could not run — ${detail}\n` +
            'No claims were checked. This is not a pass and not a failure of the text.',
        };
      }

      const guardReport = evaluateGuard(guardResult, failOn);
      const guardOutput =
        flags['json'] === 'true'
          ? formatGuardJson(guardReport, failOn)
          : formatGuardReport(guardReport, failOn);

      return { exitCode: guardReport.exitCode, output: guardOutput };
    }

    case 'critique': {
      const inputPath = flags['input'];
      if (!inputPath) {
        return { exitCode: 1, output: 'Error: --input <file> is required for critique.\n\n' + usage() };
      }

      const resolvedCrit = resolve(inputPath);
      if (!existsSync(resolvedCrit)) {
        return { exitCode: 1, output: `Error: File not found: ${resolvedCrit}` };
      }

      const critText = readFileSync(resolvedCrit, 'utf-8').trim();
      if (!critText) {
        return { exitCode: 1, output: 'Error: Input file is empty.' };
      }

      const critConfig = loadConfig();
      const { provider: critProviderName, minConfidence: critMinConf } = mergeFlags(critConfig, flags);
      const resolvedCritProvider = critProviderName || 'gemini';

      // Resolve API key (same pattern as scan command)
      let critApiKey = '';
      if (resolvedCritProvider !== 'mock') {
        const keyMap: Record<string, string> = {
          claude: 'ANTHROPIC_API_KEY',
          openai: 'OPENAI_API_KEY',
          gemini: 'GEMINI_API_KEY',
          perplexity: 'PERPLEXITY_API_KEY',
        };
        critApiKey = process.env[keyMap[resolvedCritProvider] || 'GEMINI_API_KEY'] || '';
        if (!critApiKey) {
          return { exitCode: 1, output: `Error: No API key found for provider "${resolvedCritProvider}". Set the appropriate environment variable or use --provider mock.` };
        }
      }

      const critScanResult = await scan(critText, resolvedCritProvider, critMinConf);

      const { getProvider: getCritProvider } = await import('../providers/registry.js');
      const critProvider = getCritProvider(critApiKey, resolvedCritProvider);
      const failedClaims = extractFailedClaims(critScanResult.claims, critScanResult.verifications);
      const critiqueResultData = await critProvider.generateCritiqueAndPrompt(critText, failedClaims);
      const critiqueAnalysis = buildCritiqueAnalysis(
        critScanResult.claims,
        critScanResult.verifications,
        critiqueResultData,
      );

      return { exitCode: 0, output: formatCritique(critiqueAnalysis, critProvider.name) };
    }

    case 'demo': {
      // Run a demonstration scan using the mock provider — no API key needed
      const demoText = `The Eiffel Tower was built in 1889 and stands 330 meters tall.
It is the most visited paid monument in the world, attracting 7 million visitors annually.
The tower was designed by Napoleon Bonaparte as a symbol of French engineering.
Scientists have proven that eating chocolate improves cognitive function by 40%.`;

      const lang = flags['lang'];
      if (lang) setLang(lang as import('../lib/i18n.js').Lang);

      process.stderr.write(`\nFaultline Demo — running on sample text with mock provider...\n`);
      process.stderr.write(`(No API key required — uses mock verification)\n\n`);

      // Import scan and report dynamically to avoid circular deps
      const { scan: runScan } = await import('./scan.js');
      const { renderReportAs } = await import('./report.js');

      const result = await runScan(demoText, 'mock');
      const report = renderReportAs(result, 'markdown', {});
      return { exitCode: 0, output: report };
    }

    case 'scan': {
      // --demo: self-contained demo mode, no API key required
      if (flags['demo'] === 'true') {
        const demoResult = getDemoResult();
        const outputFormat = (flags['output-format'] as OutputFormat) || 'markdown';
        const report = renderReportAs(demoResult, outputFormat, {});
        return { exitCode: 0, output: report };
      }

      const inputPath = flags['input'];
      const dirPath = flags['dir'];
      const templateFlag = flags['templates'];
      const fileFlag = flags['file'];
      const namedTemplateFlag = flags['template']; // singular — named local template from .faultlinerc.json

      if (!inputPath && !dirPath && !templateFlag && !fileFlag) {
        return { exitCode: 1, output: 'Error: --input <file>, --dir <path>, --templates <categories>, or --file <path> is required.\n\n' + usage() };
      }

      if (fileFlag && inputPath) {
        return { exitCode: 1, output: 'Error: --file and --input are mutually exclusive. Use one or the other.' };
      }

      // Load config file (walks up from cwd), then merge with CLI flags
      const config = loadConfig();
      let { provider: providerName, minConfidence, outputFormat, ruleNames } = mergeFlags(config, flags);

      // Auto-load plugins from config before scanning
      if (config.plugins?.length) {
        await loadPluginsFromConfig(config.plugins);
      }

      // Auto-detect provider from env if not explicitly specified
      if (!flags['provider'] && !config.provider) {
        providerName = autoDetectProvider();
      }

      // --sarif shorthand: sets format to sarif and writes results.sarif
      const sarifShorthand = flags['sarif'] === 'true';
      if (sarifShorthand) {
        outputFormat = 'sarif';
      }

      if (minConfidence !== undefined && (isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1)) {
        return { exitCode: 1, output: 'Error: --min-confidence must be a number between 0.0 and 1.0.' };
      }
      if (!['json', 'markdown', 'html', 'sarif'].includes(outputFormat)) {
        return { exitCode: 1, output: 'Error: --output-format must be json, markdown, html, or sarif.' };
      }

      if (ruleNames) {
        const available = listRules();
        for (const name of ruleNames) {
          if (!available.includes(name)) {
            return { exitCode: 1, output: `Error: Unknown rule "${name}". Available: ${available.join(', ')}` };
          }
        }
      }

      // --template (singular): apply named local template from .faultlinerc.json
      // CLI flags always take precedence over template values.
      if (namedTemplateFlag) {
        const localTemplate = getLocalTemplate(config, namedTemplateFlag);
        if (!localTemplate) {
          return {
            exitCode: 1,
            output: `Error: Template "${namedTemplateFlag}" not found in .faultlinerc.json. Available templates: ${Object.keys(config.templates ?? {}).join(', ') || '(none)'}`,
          };
        }
        if (!flags['provider'] && localTemplate.provider) providerName = localTemplate.provider;
        if (!flags['rules'] && localTemplate.rules) ruleNames = localTemplate.rules;
        if (!flags['min-confidence'] && localTemplate['min-confidence'] !== undefined) minConfidence = localTemplate['min-confidence'];
      }

      // --fail-on threshold (optional — omitted = always exit 0)
      const failOnFlag = flags['fail-on'] as SeverityLevel | undefined;
      // If a named template supplies fail-on and no explicit CLI flag was given, use the template value.
      const effectiveFailOn: SeverityLevel | undefined =
        failOnFlag ??
        (namedTemplateFlag ? (getLocalTemplate(config, namedTemplateFlag)?.['fail-on'] as SeverityLevel | undefined) : undefined);
      const validSeverities: SeverityLevel[] = ['critical', 'high', 'medium', 'low'];
      if (effectiveFailOn && !validSeverities.includes(effectiveFailOn)) {
        return { exitCode: 1, output: `Error: --fail-on must be one of: ${validSeverities.join(', ')}.` };
      }

      // --- Template scan mode ---
      if (templateFlag) {
        const categories = templateFlag.split(',').map((s: string) => s.trim());
        const unknown = validateCategories(categories);
        if (unknown.length > 0) {
          return { exitCode: 1, output: `Error: Unknown template category "${unknown[0]}". Available: ${listCategories().join(', ')}` };
        }

        const apiKeyErr = checkApiKey(providerName);
        if (apiKeyErr) return apiKeyErr;

        const templates = getTemplatesByCategories(categories as TemplateCategory[]);
        if (templates.length === 0) {
          return { exitCode: 1, output: `Error: No templates found for categories: ${categories.join(', ')}` };
        }

        const templateResults: Array<{ templateId: string; category: string; severity: string; prompt: string; result: import('./scan.js').ScanResult }> = [];
        for (const tmpl of templates) {
          const result = await scan(tmpl.prompt_text, providerName, minConfidence, ruleNames);
          templateResults.push({
            templateId: tmpl.id,
            category: tmpl.category,
            severity: tmpl.severity,
            prompt: tmpl.prompt_text,
            result,
          });
        }

        const templateOutput = JSON.stringify({
          mode: 'template-scan',
          categories,
          templatesScanned: templates.length,
          results: templateResults,
        }, null, 2);

        if (effectiveFailOn) {
          const degradedFail = degradedGateFailure(
            templateResults.some(tr => tr.result.degraded === true),
            templateOutput,
          );
          if (degradedFail) return degradedFail;
          // Aggregate counts across all template results
          const totalCounts = { findings: 0, critical: 0, high: 0, medium: 0, low: 0 };
          for (const tr of templateResults) {
            const c = countFromScanResult(tr.result as unknown as Record<string, unknown>);
            totalCounts.findings += c.findings;
            totalCounts.critical += c.critical;
            totalCounts.high += c.high;
            totalCounts.medium += c.medium;
            totalCounts.low += c.low;
          }
          const passed = checkThreshold(effectiveFailOn, totalCounts);
          return { exitCode: passed ? 0 : 1, output: templateOutput };
        }

        return { exitCode: 0, output: templateOutput };
      }

      // --- Directory/batch mode ---
      if (dirPath) {
        const resolvedDir = resolve(dirPath);
        if (!existsSync(resolvedDir)) {
          return { exitCode: 1, output: `Error: Directory not found: ${resolvedDir}` };
        }
        try {
          if (!statSync(resolvedDir).isDirectory()) {
            return { exitCode: 1, output: `Error: Not a directory: ${resolvedDir}` };
          }
        } catch {
          return { exitCode: 1, output: `Error: Cannot read: ${resolvedDir}` };
        }

        const apiKeyErrBatch = checkApiKey(providerName);
        if (apiKeyErrBatch) return apiKeyErrBatch;

        const globPattern = flags['glob'] || undefined;
        const batchResult = await batchScan(resolvedDir, providerName, minConfidence, globPattern);

        if (batchResult.filesScanned === 0) {
          return { exitCode: 1, output: `Error: No files found in ${resolvedDir}${globPattern ? ` matching "${globPattern}"` : ''}.` };
        }

        const batchOutput = JSON.stringify(batchResult, null, 2);

        printConversionNudge(batchResult.summary.highestRisk, flags['no-nudge'] === 'true');

        if (effectiveFailOn) {
          const degradedFail = degradedGateFailure(
            batchResult.results.some(fr => fr.result.degraded === true),
            batchOutput,
          );
          if (degradedFail) return degradedFail;
          const totalCounts = { findings: 0, critical: 0, high: 0, medium: 0, low: 0 };
          for (const fr of batchResult.results) {
            const c = countFromScanResult(fr.result as unknown as Record<string, unknown>);
            totalCounts.findings += c.findings;
            totalCounts.critical += c.critical;
            totalCounts.high += c.high;
            totalCounts.medium += c.medium;
            totalCounts.low += c.low;
          }
          const passed = checkThreshold(effectiveFailOn, totalCounts);
          return { exitCode: passed ? 0 : 1, output: batchOutput };
        }

        return { exitCode: 0, output: batchOutput };
      }

      // --- File upload mode (PDF/image extraction) ---
      if (fileFlag) {
        const resolvedFile = resolve(fileFlag);
        if (!existsSync(resolvedFile)) {
          return { exitCode: 1, output: `Error: File not found: ${resolvedFile}` };
        }

        const apiKeyErrFile = checkApiKey(providerName);
        if (apiKeyErrFile) return apiKeyErrFile;

        let extractedText: string;
        try {
          const { extractTextFromFile } = await import('./extract.js');
          extractedText = await extractTextFromFile(resolvedFile);
        } catch (extractErr) {
          const message = extractErr instanceof Error ? extractErr.message : String(extractErr);
          return { exitCode: 1, output: `Error: ${message}` };
        }

        if (!extractedText.trim()) {
          return { exitCode: 1, output: 'Error: No text could be extracted from the file.' };
        }

        const fileSpinner = await createScanSpinner(outputFormat);
        let fileResult;
        try {
          fileResult = await scan(extractedText, providerName, minConfidence, ruleNames, fileSpinner.onProgress);
          fileSpinner.succeed('Scan complete');
        } catch (err) {
          fileSpinner.fail('Scan failed');
          throw err;
        }

        const fileSarifOptions: SarifOptions = { inputUri: fileFlag };
        const fileOutput = renderReportAs(fileResult, outputFormat, fileSarifOptions);

        if (effectiveFailOn) {
          const degradedFail = degradedGateFailure(fileResult.degraded === true, fileOutput);
          if (degradedFail) return degradedFail;
          const counts = countFromScanResult(fileResult as unknown as Record<string, unknown>);
          const passed = checkThreshold(effectiveFailOn, counts);
          return { exitCode: passed ? 0 : 1, output: fileOutput };
        }

        return { exitCode: 0, output: fileOutput };
      }

      // --- Single file mode ---
      const resolved = resolve(inputPath!);
      if (!existsSync(resolved)) {
        return { exitCode: 1, output: `Error: File not found: ${resolved}` };
      }

      const text = readFileSync(resolved, 'utf-8').trim();
      if (!text) {
        return { exitCode: 1, output: 'Error: Input file is empty.' };
      }

      const apiKeyErrSingle = checkApiKey(providerName);
      if (apiKeyErrSingle) return apiKeyErrSingle;

      const spinner = await createScanSpinner(outputFormat);
      let result;
      try {
        result = await scan(text, providerName, minConfidence, ruleNames, spinner.onProgress);
        spinner.succeed('Scan complete');
        sendTelemetry({ version: VERSION, provider: result.provider, exit_status: 0, eval_count: result.claims.length });
      } catch (err) {
        spinner.fail('Scan failed');
        sendTelemetry({ version: VERSION, provider: providerName ?? 'unknown', exit_status: 1, eval_count: 0, error_code: classifyError(err) });
        throw err;
      }

      // Save to history
      const scanHistoryDir = flags['history-dir'] || undefined;
      saveHistoryEntry(result, inputPath!, scanHistoryDir);

      const sarifOptions: SarifOptions = { inputUri: inputPath! };
      const scanOutput = renderReportAs(result, outputFormat, sarifOptions);

      // --sarif shorthand: also write results.sarif file
      if (sarifShorthand) {
        writeFileSync(resolve('results.sarif'), scanOutput, 'utf-8');
      }

      printConversionNudge(result.overallRisk, flags['no-nudge'] === 'true');

      if (effectiveFailOn) {
        const degradedFail = degradedGateFailure(result.degraded === true, scanOutput);
        if (degradedFail) return degradedFail;
        const counts = countFromScanResult(result as unknown as Record<string, unknown>);
        const passed = checkThreshold(effectiveFailOn, counts);
        return { exitCode: passed ? 0 : 1, output: scanOutput };
      }

      return { exitCode: 0, output: scanOutput };
    }

    case 'compare': {
      const beforeInput = flags['before'];
      const afterInput  = flags['after'];
      const compareProvider = flags['provider'];
      const outputFormat = (flags['output-format'] ?? 'text') as 'text' | 'json';

      if (!beforeInput || !afterInput) {
        return {
          exitCode: 1,
          output: 'Usage: faultline compare --before <text|file> --after <text|file> [--provider mock] [--output-format text|json]',
        };
      }

      // Check API key if not mock
      const keyCheck = checkApiKey(compareProvider);
      if (keyCheck) return keyCheck;

      // Resolve inputs: if file exists, read it; otherwise treat as literal text
      function resolveInput(input: string): string {
        try {
          if (existsSync(resolve(input))) return readFileSync(resolve(input), 'utf8').trim();
        } catch { /* not a file */ }
        return input;
      }

      const textBefore = resolveInput(beforeInput);
      const textAfter  = resolveInput(afterInput);

      if (!textBefore) return { exitCode: 1, output: 'Error: --before input is empty.' };
      if (!textAfter)  return { exitCode: 1, output: 'Error: --after input is empty.' };

      // Run both scans
      const [scanBefore, scanAfter] = await Promise.all([
        scan(textBefore, compareProvider),
        scan(textAfter, compareProvider),
      ]);

      const compareResult = compareScanResults(scanBefore, scanAfter);
      return { exitCode: 0, output: renderCompare(compareResult, outputFormat) };
    }

    case 'report': {
      const inputPath = flags['input'];
      if (!inputPath) {
        return { exitCode: 1, output: 'Error: --input <results.json> is required.\n\n' + usage() };
      }

      const resolved = resolve(inputPath);
      if (!existsSync(resolved)) {
        return { exitCode: 1, output: `Error: File not found: ${resolved}` };
      }

      try {
        const data = JSON.parse(readFileSync(resolved, 'utf-8'));
        const outputFormat = (flags['output-format'] || undefined) as OutputFormat | undefined;
        if (outputFormat && !['json', 'markdown', 'html', 'sarif'].includes(outputFormat)) {
          return { exitCode: 1, output: 'Error: --output-format must be json, markdown, html, or sarif.' };
        }
        const output = outputFormat ? renderReportAs(data, outputFormat) : renderReport(data);
        return { exitCode: 0, output };
      } catch {
        return { exitCode: 1, output: 'Error: Invalid JSON in input file.' };
      }
    }

    case 'export': {
      const exportFormat = (flags['format'] || 'csv') as ExportFormat;
      if (!['csv', 'json', 'ndjson'].includes(exportFormat)) {
        return { exitCode: 1, output: 'Error: --format must be csv, json, or ndjson.' };
      }

      const historyDir = flags['history-dir'];
      const allEntries = listHistory(historyDir, { all: true });

      const filtered = applyFilter(allEntries, {
        from:     flags['from'],
        to:       flags['to'],
        provider: flags['provider'],
        risk:     flags['risk'],
      });

      if (filtered.length === 0) {
        return { exitCode: 0, output: 'No scan history entries matched the given filters.' };
      }

      const content = renderExport(filtered, exportFormat);

      const outputPath = flags['output'];
      if (outputPath) {
        writeFileSync(resolve(outputPath), content, 'utf-8');
        return { exitCode: 0, output: `Exported ${filtered.length} scan(s) to ${resolve(outputPath)}` };
      }

      // No --output flag → write to stdout (allows piping)
      return { exitCode: 0, output: content.trimEnd() };
    }

    case 'keys': {
      const sub = args[1]; // list | dormant | expiring | rotate
      const apiUrl = flags['api-url'] || process.env.FAULTLINE_API_URL || 'http://localhost:3000';
      const apiKey = flags['api-key'] || process.env.FAULTLINE_API_KEY || '';

      if (!apiKey) {
        return {
          exitCode: 1,
          output: 'Error: --api-key or FAULTLINE_API_KEY environment variable is required for key management.\n\nUsage: faultline keys list --api-url http://localhost:3000 --api-key <admin-key>',
        };
      }

      if (sub === 'list') {
        const result = await listKeys(apiUrl, apiKey);
        if (result.error) return { exitCode: 1, output: `Error: ${result.error}` };
        return { exitCode: 0, output: formatKeyList(result.keys) };
      }

      if (sub === 'dormant') {
        const days = Math.max(1, parseInt(flags['days'] ?? '30', 10));
        const result = await getDormantKeys(apiUrl, apiKey, isNaN(days) ? 30 : days);
        if (result.error) return { exitCode: 1, output: `Error: ${result.error}` };
        return { exitCode: 0, output: formatDormantList(result) };
      }

      if (sub === 'expiring') {
        const days = Math.max(1, parseInt(flags['days'] ?? '7', 10));
        const result = await getExpiringSoonKeys(apiUrl, apiKey, isNaN(days) ? 7 : days);
        if (result.error) return { exitCode: 1, output: `Error: ${result.error}` };
        return { exitCode: 0, output: formatExpiringSoonList(result) };
      }

      if (sub === 'rotate') {
        const keyId = args[2]?.startsWith('--') ? undefined : args[2];
        if (!keyId) return { exitCode: 1, output: 'Usage: faultline keys rotate <key-id> [--api-url URL] [--api-key KEY]' };
        const result = await rotateKey(apiUrl, apiKey, keyId);
        if (result.error) return { exitCode: 1, output: `Error: ${result.error}` };
        return { exitCode: 0, output: formatRotateResult(result) };
      }

      if (sub === 'rotation') {
        const days = Math.min(365, Math.max(1, parseInt(flags['days'] ?? '90', 10) || 90));
        const result = await getRotationStatus(apiUrl, apiKey, days);
        if (result.error) return { exitCode: 1, output: `Error: ${result.error}` };
        return { exitCode: 0, output: formatRotationStatus(result) };
      }

      if (sub === 'prune') {
        const days    = Math.min(365, Math.max(1, parseInt(flags['days'] ?? '90', 10) || 90));
        const confirm = 'confirm' in flags;
        if (!confirm) {
          const preview = await getKeysPrunePreview(apiUrl, apiKey, days);
          if (preview.error) return { exitCode: 1, output: `Error: ${preview.error}` };
          return { exitCode: 0, output: formatPrunePreview(preview) };
        }
        const result = await pruneKeys(apiUrl, apiKey, days);
        if (result.error) return { exitCode: 1, output: `Error: ${result.error}` };
        return { exitCode: 0, output: formatPruneResult(result) };
      }

      return {
        exitCode: 1,
        output: 'Usage:\n  faultline keys list [--api-url URL] [--api-key KEY]\n  faultline keys dormant [--days 30] [--api-url URL] [--api-key KEY]\n  faultline keys expiring [--days 7] [--api-url URL] [--api-key KEY]\n  faultline keys rotate <id> [--api-url URL] [--api-key KEY]\n  faultline keys rotation [--days 90] [--api-url URL] [--api-key KEY]\n  faultline keys prune [--days 90] [--confirm] [--api-url URL] [--api-key KEY]',
      };
    }

    case 'scans': {
      const sub    = args[1]; // stale | usage | prune
      const apiUrl = flags['api-url'] || process.env.FAULTLINE_API_URL || 'http://localhost:3000';
      const apiKey = flags['api-key'] || process.env.FAULTLINE_API_KEY || '';

      if (!apiKey) {
        return {
          exitCode: 1,
          output: 'Error: --api-key or FAULTLINE_API_KEY environment variable is required.\n\nUsage: faultline scans stale --api-url http://localhost:3000 --api-key <key>',
        };
      }

      if (sub === 'stale') {
        const days = Math.min(365, Math.max(1, parseInt(flags['days'] ?? '30', 10) || 30));
        const result = await getStaleScans(apiUrl, apiKey, days);
        if (result.error) return { exitCode: 1, output: `Error: ${result.error}` };
        return { exitCode: 0, output: formatStaleList(result) };
      }

      if (sub === 'usage') {
        const staleDays = Math.min(365, Math.max(1, parseInt(flags['staleDays'] ?? '30', 10) || 30));
        const result = await getScanUsage(apiUrl, apiKey, staleDays);
        if (result.error) return { exitCode: 1, output: `Error: ${result.error}` };
        return { exitCode: 0, output: formatScanUsage(result) };
      }

      if (sub === 'prune') {
        const days    = Math.min(365, Math.max(1, parseInt(flags['days'] ?? '30', 10) || 30));
        const confirm = 'confirm' in flags;
        if (!confirm) {
          const preview = await getScansPrunePreview(apiUrl, apiKey, days);
          if (preview.error) return { exitCode: 1, output: `Error: ${preview.error}` };
          return { exitCode: 0, output: formatScansPrunePreview(preview) };
        }
        const result = await pruneScans(apiUrl, apiKey, days);
        if (result.error) return { exitCode: 1, output: `Error: ${result.error}` };
        return { exitCode: 0, output: formatScansPruneResult(result) };
      }

      return {
        exitCode: 1,
        output: 'Usage:\n  faultline scans stale [--days 30] [--api-url URL] [--api-key KEY]\n  faultline scans usage [--staleDays 30] [--api-url URL] [--api-key KEY]\n  faultline scans prune [--days 30] [--confirm] [--api-url URL] [--api-key KEY]',
      };
    }

    case 'stream': {
      const text    = flags['text'] || (args[1]?.startsWith('--') ? '' : args[1]) || '';
      const apiUrl  = flags['api-url'] || process.env.FAULTLINE_API_URL || 'http://localhost:3000';
      const apiKey  = flags['api-key'] || process.env.FAULTLINE_API_KEY || '';
      const provider = flags['provider'] || 'mock';

      if (!apiKey) {
        return { exitCode: 1, output: 'Error: --api-key or FAULTLINE_API_KEY environment variable is required.\n\nUsage: faultline stream <text> --api-key <key>' };
      }
      if (!text) {
        return { exitCode: 1, output: 'Error: provide text as first argument or --text flag.\n\nUsage: faultline stream <text> [--provider mock] [--api-key KEY] [--api-url URL]' };
      }

      const streamResult = await streamScan(apiUrl, apiKey, text, provider);
      if (streamResult.error) return { exitCode: 1, output: `Error: ${streamResult.error}` };
      return { exitCode: 0, output: formatStreamResult(streamResult) };
    }

    case 'compliance-report': {
      // Diff mode: compare two compliance reports
      if (flags['diff']) {
        const diffParts = flags['diff'].split(',');
        if (diffParts.length !== 2) {
          return { exitCode: 1, output: 'Error: --diff requires two comma-separated scan JSON paths.\n\nUsage: faultline compliance-report --diff before.json,after.json' };
        }
        const [beforePath, afterPath] = diffParts.map(p => resolve(p.trim()));
        for (const p of [beforePath, afterPath]) {
          if (!existsSync(p)) return { exitCode: 1, output: `Error: file not found: ${p}` };
        }
        let beforeScan, afterScan;
        try { beforeScan = JSON.parse(readFileSync(beforePath, 'utf-8')); } catch { return { exitCode: 1, output: `Error: could not parse ${beforePath}` }; }
        try { afterScan = JSON.parse(readFileSync(afterPath, 'utf-8')); } catch { return { exitCode: 1, output: `Error: could not parse ${afterPath}` }; }
        const beforeReport = buildEuComplianceReport(beforeScan, { projectName: flags['project-name'] });
        const afterReport = buildEuComplianceReport(afterScan, { projectName: flags['project-name'] });
        const diff = diffComplianceReports(beforeReport, afterReport);
        if (flags['format'] === 'json') {
          const jsonOut = JSON.stringify(diff, null, 2);
          if (flags['output']) { writeFileSync(resolve(flags['output']), jsonOut, 'utf-8'); return { exitCode: 0, output: `Compliance diff written to ${flags['output']}` }; }
          return { exitCode: 0, output: jsonOut };
        }
        return { exitCode: diff.regressed > 0 ? 1 : 0, output: renderComplianceDiffOutput(diff) };
      }

      // Resolve scan result: from --input file or by running a fresh scan
      let crScanResult;
      if (flags['input']) {
        const inputPath = resolve(flags['input']);
        if (!existsSync(inputPath)) {
          return { exitCode: 1, output: `Error: file not found: ${flags['input']}` };
        }
        try {
          crScanResult = JSON.parse(readFileSync(inputPath, 'utf-8'));
        } catch {
          return { exitCode: 1, output: `Error: could not parse scan result JSON from ${flags['input']}` };
        }
      } else if (flags['text']) {
        const crProvider = flags['provider'] || autoDetectProvider();
        const keyError = checkApiKey(crProvider);
        if (keyError) return keyError;
        crScanResult = await scan(flags['text'], crProvider);
      } else {
        return {
          exitCode: 1,
          output:
            'Error: provide --input <scan-result.json> or --text <text>.\n\n' +
            'Usage: faultline compliance-report --input scan.json [--format json|pdf|markdown|sarif|html] [--output eu-report.pdf]',
        };
      }

      const crFormat = (flags['format'] || 'json') as 'json' | 'pdf' | 'markdown' | 'sarif' | 'html';

      // Load config file (if present) — CLI flags override config values
      const config = loadComplianceConfig(flags['config']);
      const crProjectName = flags['project-name'] || config?.projectName;
      const crReport = buildEuComplianceReport(crScanResult, { projectName: crProjectName });

      // CI gate mode: evaluate and exit with pass/fail
      if (flags['ci'] === 'true') {
        const threshold = flags['threshold'] ? parseInt(flags['threshold'], 10) : (config?.threshold ?? 0);
        const strict = flags['strict'] === 'true' || (config?.strict ?? false);
        const gate = evaluateComplianceGate(crReport, { threshold, strict });
        const ciOutput = renderCiGateOutput(gate, crReport);
        // If --output specified, also write the full JSON report alongside
        if (flags['output']) {
          writeFileSync(resolve(flags['output']), renderComplianceReportJson(crReport), 'utf-8');
        }
        return { exitCode: gate.exitCode, output: ciOutput };
      }

      if (crFormat === 'pdf') {
        const pdfBuf = await renderComplianceReportPdf(crReport);
        const outPath = flags['output'] || `eu-compliance-report-${crReport.documentRef}.pdf`;
        writeFileSync(resolve(outPath), pdfBuf);
        return { exitCode: 0, output: `EU AI Act compliance report written to ${outPath}` };
      }

      if (crFormat === 'markdown') {
        const gate = evaluateComplianceGate(crReport, {
          threshold: flags['threshold'] ? parseInt(flags['threshold'], 10) : (config?.threshold ?? 0),
          strict: flags['strict'] === 'true' || (config?.strict ?? false),
        });
        const mdOut = renderComplianceReportMarkdown(crReport, gate);
        if (flags['output']) {
          writeFileSync(resolve(flags['output']), mdOut, 'utf-8');
          return { exitCode: 0, output: `EU AI Act compliance report (Markdown) written to ${flags['output']}` };
        }
        return { exitCode: 0, output: mdOut };
      }

      if (crFormat === 'sarif') {
        const gate = evaluateComplianceGate(crReport, {
          threshold: flags['threshold'] ? parseInt(flags['threshold'], 10) : (config?.threshold ?? 0),
          strict: flags['strict'] === 'true' || (config?.strict ?? false),
        });
        const sarifOut = renderComplianceReportSarif(crReport, gate);
        if (flags['output']) {
          writeFileSync(resolve(flags['output']), sarifOut, 'utf-8');
          return { exitCode: 0, output: `EU AI Act compliance report (SARIF) written to ${flags['output']}` };
        }
        return { exitCode: 0, output: sarifOut };
      }

      if (crFormat === 'html') {
        const gate = evaluateComplianceGate(crReport, {
          threshold: flags['threshold'] ? parseInt(flags['threshold'], 10) : (config?.threshold ?? 0),
          strict: flags['strict'] === 'true' || (config?.strict ?? false),
        });
        const htmlOut = renderComplianceReportHtml(crReport, gate);
        const outPath = flags['output'] || `eu-compliance-report-${crReport.documentRef}.html`;
        writeFileSync(resolve(outPath), htmlOut, 'utf-8');
        return { exitCode: 0, output: `EU AI Act compliance report (HTML) written to ${outPath}` };
      }

      const jsonOut = renderComplianceReportJson(crReport);
      if (flags['output']) {
        writeFileSync(resolve(flags['output']), jsonOut, 'utf-8');
        return { exitCode: 0, output: `EU AI Act compliance report written to ${flags['output']}` };
      }
      return { exitCode: 0, output: jsonOut };
    }

    default:
      return { exitCode: command ? 1 : 0, output: (command ? `Unknown command: ${command}\n\n` : '') + usage() };
  }
}

// Run when executed directly
const isDirectRun = process.argv[1]?.includes('cli/index');
if (isDirectRun) {
  main(process.argv.slice(2)).then(({ exitCode, output }) => {
    console.log(output);
    process.exit(exitCode);
  });
}
