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
import { scan, batchScan } from './scan.js';
import { renderReport, renderReportAs, type OutputFormat, type SarifOptions } from './report.js';
import { listRules, getRule } from '../rules/index.js';
import { loadConfig, mergeFlags, generateSampleConfig } from './config.js';
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

const VERSION = '0.1.0';

const API_KEY_MAP: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

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
  faultline scan --input <file> [--provider gemini|claude|openai|mock] [--min-confidence 0.0-1.0] [--output-format json|markdown|html|sarif] [--sarif] [--rules pii,bias,toxicity] [--fail-on critical|high|medium|low]
  faultline scan --dir <path> [--glob "*.txt"] [--provider gemini] [--output-format sarif] [--fail-on high]
  faultline aggregate --dir <path> [--output-format json|markdown|html|sarif]  Aggregate scan results
  faultline report --input <results.json> [--output-format json|markdown|html|sarif]
  faultline watch --dir <path> [--provider gemini] [--output-format json]   Watch for changes
  faultline scan --templates injection,bias                         Red-team scan with template categories
  faultline templates list [--category injection]                   List red-team prompt templates
  faultline history [--all] [--history-dir <path>]                  List past scans
  faultline trend --file <path> [--history-dir <path>]             Show finding trend for a file
  faultline weakest --input <file> [--provider gemini] [--top N]       Identify the weakest-link claim
  faultline graph --input <file> [--format mermaid|dot]             Export claim graph
  faultline critique --input <file> [--provider gemini]             Critique failed claims + improved prompt
  faultline rules                                                   List available rules
  faultline init                                                    Generate .faultlinerc.json
  faultline version                                                 Print version

Config:
  Reads .faultlinerc.json from cwd (walks up). CLI flags override config values.

Environment:
  GEMINI_API_KEY       API key for Gemini provider (free: https://aistudio.google.com/apikey)
  ANTHROPIC_API_KEY    API key for Claude provider
  OPENAI_API_KEY       API key for OpenAI provider
  FAULTLINE_PROVIDER   Default provider (gemini|claude|openai)

For CI/testing without an API key, use --provider mock (returns synthetic results).`;
}

// Boolean flags that take no value argument
const BOOLEAN_FLAGS = new Set(['sarif', 'all']);

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

  switch (command) {
    case 'version':
    case '--version':
    case '-v':
      return { exitCode: 0, output: `Faultline v${VERSION}` };

    case 'help':
    case '--help':
    case '-h':
      return { exitCode: 0, output: usage() };

    case 'rules': {
      const rules = listRules();
      const lines = ['Available rules:', ''];
      for (const name of rules) {
        const rule = getRule(name);
        lines.push(`  ${rule.id.padEnd(12)} ${rule.name} — ${rule.description}`);
      }
      return { exitCode: 0, output: lines.join('\n') };
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
      return { exitCode: 0, output: `Created ${filePath}` };
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

    case 'scan': {
      const inputPath = flags['input'];
      const dirPath = flags['dir'];
      const templateFlag = flags['templates'];

      if (!inputPath && !dirPath && !templateFlag) {
        return { exitCode: 1, output: 'Error: --input <file>, --dir <path>, or --templates <categories> is required.\n\n' + usage() };
      }

      // Load config file (walks up from cwd), then merge with CLI flags
      const config = loadConfig();
      let { provider: providerName, minConfidence, outputFormat, ruleNames } = mergeFlags(config, flags);

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

      // --fail-on threshold (optional — omitted = always exit 0)
      const failOnFlag = flags['fail-on'] as SeverityLevel | undefined;
      const validSeverities: SeverityLevel[] = ['critical', 'high', 'medium', 'low'];
      if (failOnFlag && !validSeverities.includes(failOnFlag)) {
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

        if (failOnFlag) {
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
          const passed = checkThreshold(failOnFlag, totalCounts);
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

        if (failOnFlag) {
          const totalCounts = { findings: 0, critical: 0, high: 0, medium: 0, low: 0 };
          for (const fr of batchResult.results) {
            const c = countFromScanResult(fr.result as unknown as Record<string, unknown>);
            totalCounts.findings += c.findings;
            totalCounts.critical += c.critical;
            totalCounts.high += c.high;
            totalCounts.medium += c.medium;
            totalCounts.low += c.low;
          }
          const passed = checkThreshold(failOnFlag, totalCounts);
          return { exitCode: passed ? 0 : 1, output: batchOutput };
        }

        return { exitCode: 0, output: batchOutput };
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

      const result = await scan(text, providerName, minConfidence, ruleNames);

      // Save to history
      const scanHistoryDir = flags['history-dir'] || undefined;
      saveHistoryEntry(result, inputPath!, scanHistoryDir);

      const sarifOptions: SarifOptions = { inputUri: inputPath! };
      const scanOutput = renderReportAs(result, outputFormat, sarifOptions);

      // --sarif shorthand: also write results.sarif file
      if (sarifShorthand) {
        writeFileSync(resolve('results.sarif'), scanOutput, 'utf-8');
      }

      if (failOnFlag) {
        const counts = countFromScanResult(result as unknown as Record<string, unknown>);
        const passed = checkThreshold(failOnFlag, counts);
        return { exitCode: passed ? 0 : 1, output: scanOutput };
      }

      return { exitCode: 0, output: scanOutput };
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
