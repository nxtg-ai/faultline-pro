/**
 * Report aggregation module.
 *
 * Takes multiple scan results (from --dir batch scanning or individual scans)
 * and produces a consolidated portfolio-level report.
 */

import type { ScanResult } from './scan.js';
import type { ComplianceReport, ConfidenceDistribution, EURiskSummary, TriggeredArticle } from '../compliance/report_generator.js';
import type { EURiskLevel, ClaimRiskMapping } from '../compliance/eu_ai_act.js';
import type { Finding } from '../rules/index.js';
import type { AnalysisState } from '../types.js';

export interface AggregatedReport {
  generatedAt: string;
  filesAnalyzed: number;
  totalFindings: number;
  totalClaims: number;
  totalVerifications: number;
  highestOverallRisk: AnalysisState['overallRisk'];
  highestEUTier: EURiskLevel;
  euRiskSummary: EURiskSummary;
  confidenceDistribution: ConfidenceDistribution;
  triggeredArticles: TriggeredArticle[];
  mitigations: string[];
  riskHeatmap: HeatmapEntry[];
  ruleFindingSummary: RuleFindingSummary;
}

export interface HeatmapEntry {
  file: string;
  findings: number;
  highestRisk: AnalysisState['overallRisk'];
  highestEUTier: EURiskLevel;
}

export interface RuleFindingSummary {
  total: number;
  bySeverity: { critical: number; high: number; medium: number; low: number; info: number };
}

/**
 * Aggregate multiple scan results into a single consolidated report.
 */
export function aggregate(fileResults: Array<{ file: string; result: ScanResult }>): AggregatedReport {
  const euSummary: EURiskSummary = {
    unacceptable: 0,
    high: 0,
    limited: 0,
    minimal: 0,
    totalClaims: 0,
    highestTier: 'minimal',
  };

  const confDist: ConfidenceDistribution = { high: 0, medium: 0, low: 0 };
  const articleMap = new Map<string, { reason: string; claimIds: string[] }>();
  const mitigationSet = new Set<string>();
  const heatmap: HeatmapEntry[] = [];
  const ruleSummary: RuleFindingSummary = {
    total: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  };

  let totalClaims = 0;
  let totalVerifications = 0;
  let totalFindings = 0;

  const riskOrder: AnalysisState['overallRisk'][] = ['critical', 'high', 'medium', 'low'];
  const euTierOrder: EURiskLevel[] = ['unacceptable', 'high', 'limited', 'minimal'];
  let highestOverallRisk: AnalysisState['overallRisk'] = 'low';
  let highestEUTier: EURiskLevel = 'minimal';

  for (const { file, result } of fileResults) {
    const report = result.complianceReport;

    totalClaims += result.claims.length;
    totalVerifications += Object.keys(result.verifications).length;

    // EU risk summary
    euSummary.unacceptable += report.euRiskSummary.unacceptable;
    euSummary.high += report.euRiskSummary.high;
    euSummary.limited += report.euRiskSummary.limited;
    euSummary.minimal += report.euRiskSummary.minimal;
    euSummary.totalClaims += report.euRiskSummary.totalClaims;

    // Confidence distribution
    if (report.confidenceDistribution) {
      confDist.high += report.confidenceDistribution.high;
      confDist.medium += report.confidenceDistribution.medium;
      confDist.low += report.confidenceDistribution.low;
    }

    // Triggered articles (deduplicate, merge claim IDs)
    for (const article of report.triggeredArticles) {
      const existing = articleMap.get(article.article);
      if (existing) {
        for (const id of article.claimIds) {
          if (!existing.claimIds.includes(id)) {
            existing.claimIds.push(id);
          }
        }
      } else {
        articleMap.set(article.article, {
          reason: article.reason,
          claimIds: [...article.claimIds],
        });
      }
    }

    // Mitigations (deduplicate)
    for (const m of report.mitigations) {
      mitigationSet.add(m);
    }

    // Rule findings
    const fileFindings = result.ruleFindings?.length || 0;
    totalFindings += fileFindings;
    for (const f of result.ruleFindings || []) {
      const sev = f.severity as keyof RuleFindingSummary['bySeverity'];
      if (sev in ruleSummary.bySeverity) {
        ruleSummary.bySeverity[sev]++;
      }
    }
    ruleSummary.total += fileFindings;

    // Also count non-supported verifications as findings
    for (const v of Object.values(result.verifications)) {
      if (v.status !== 'supported') {
        totalFindings++;
      }
    }

    // Track highest overall risk
    const riskIdx = riskOrder.indexOf(result.overallRisk);
    const currentRiskIdx = riskOrder.indexOf(highestOverallRisk);
    if (riskIdx < currentRiskIdx) {
      highestOverallRisk = result.overallRisk;
    }

    // Track highest EU tier
    const euIdx = euTierOrder.indexOf(report.euRiskSummary.highestTier);
    const currentEUIdx = euTierOrder.indexOf(highestEUTier);
    if (euIdx < currentEUIdx) {
      highestEUTier = report.euRiskSummary.highestTier;
    }

    // Heatmap entry
    heatmap.push({
      file,
      findings: fileFindings + Object.values(result.verifications).filter(v => v.status !== 'supported').length,
      highestRisk: result.overallRisk,
      highestEUTier: report.euRiskSummary.highestTier,
    });
  }

  // Set highest tier on summary
  euSummary.highestTier = highestEUTier;

  // Sort heatmap by findings descending
  heatmap.sort((a, b) => b.findings - a.findings);

  // Assemble triggered articles
  const triggeredArticles: TriggeredArticle[] = [];
  for (const [article, data] of articleMap) {
    triggeredArticles.push({ article, ...data });
  }

  return {
    generatedAt: new Date().toISOString(),
    filesAnalyzed: fileResults.length,
    totalFindings,
    totalClaims,
    totalVerifications,
    highestOverallRisk,
    highestEUTier,
    euRiskSummary: euSummary,
    confidenceDistribution: confDist,
    triggeredArticles,
    mitigations: [...mitigationSet],
    riskHeatmap: heatmap,
    ruleFindingSummary: ruleSummary,
  };
}

// --- Renderers ---

function riskBadge(level: string): string {
  const upper = level.toUpperCase();
  switch (upper) {
    case 'CRITICAL': return '🔴 CRITICAL';
    case 'HIGH': return '🟠 HIGH';
    case 'UNACCEPTABLE': return '🔴 UNACCEPTABLE';
    case 'MEDIUM': return '🟡 MEDIUM';
    case 'LIMITED': return '🟡 LIMITED';
    case 'LOW': return '🟢 LOW';
    case 'MINIMAL': return '🟢 MINIMAL';
    default: return upper;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function riskColor(level: string): string {
  switch (level.toLowerCase()) {
    case 'critical':
    case 'unacceptable': return '#dc2626';
    case 'high': return '#ea580c';
    case 'medium':
    case 'limited': return '#ca8a04';
    case 'low':
    case 'minimal': return '#16a34a';
    default: return '#6b7280';
  }
}

export type AggregateOutputFormat = 'json' | 'markdown' | 'html' | 'sarif';

export function renderAggregatedReport(report: AggregatedReport, format: AggregateOutputFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(report, null, 2);
    case 'markdown':
      return renderAggregatedMarkdown(report);
    case 'html':
      return renderAggregatedHtml(report);
    case 'sarif':
      return renderAggregatedSarif(report);
    default:
      return JSON.stringify(report, null, 2);
  }
}

function renderAggregatedMarkdown(report: AggregatedReport): string {
  const lines: string[] = [];

  lines.push('# Faultline Aggregated Compliance Report');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| **Files Analyzed** | ${report.filesAnalyzed} |`);
  lines.push(`| **Total Findings** | ${report.totalFindings} |`);
  lines.push(`| **Total Claims** | ${report.totalClaims} |`);
  lines.push(`| **Overall Risk** | ${riskBadge(report.highestOverallRisk)} |`);
  lines.push(`| **EU Risk Tier** | ${riskBadge(report.highestEUTier)} |`);
  lines.push(`| **Generated** | ${report.generatedAt} |`);
  lines.push('');

  // EU risk summary
  lines.push('## EU AI Act Risk Summary');
  lines.push('');
  lines.push('| Risk Level | Count |');
  lines.push('|------------|-------|');
  lines.push(`| ${riskBadge('unacceptable')} | ${report.euRiskSummary.unacceptable} |`);
  lines.push(`| ${riskBadge('high')} | ${report.euRiskSummary.high} |`);
  lines.push(`| ${riskBadge('limited')} | ${report.euRiskSummary.limited} |`);
  lines.push(`| ${riskBadge('minimal')} | ${report.euRiskSummary.minimal} |`);
  lines.push(`| **Total** | **${report.euRiskSummary.totalClaims}** |`);
  lines.push('');

  // Confidence distribution
  const cd = report.confidenceDistribution;
  lines.push('## Confidence Distribution');
  lines.push('');
  lines.push('| Band | Count |');
  lines.push('|------|-------|');
  lines.push(`| High (≥0.8) | ${cd.high} |`);
  lines.push(`| Medium (0.5–0.8) | ${cd.medium} |`);
  lines.push(`| Low (<0.5) | ${cd.low} |`);
  lines.push('');

  // Rule findings summary
  if (report.ruleFindingSummary.total > 0) {
    const rs = report.ruleFindingSummary;
    lines.push('## Rule Findings Summary');
    lines.push('');
    lines.push('| Severity | Count |');
    lines.push('|----------|-------|');
    lines.push(`| Critical | ${rs.bySeverity.critical} |`);
    lines.push(`| High | ${rs.bySeverity.high} |`);
    lines.push(`| Medium | ${rs.bySeverity.medium} |`);
    lines.push(`| Low | ${rs.bySeverity.low} |`);
    lines.push(`| **Total** | **${rs.total}** |`);
    lines.push('');
  }

  // Risk heatmap
  if (report.riskHeatmap.length > 0) {
    lines.push('## Risk Heatmap');
    lines.push('');
    lines.push('| File | Findings | Risk | EU Tier |');
    lines.push('|------|----------|------|---------|');
    for (const entry of report.riskHeatmap) {
      lines.push(`| ${entry.file} | ${entry.findings} | ${riskBadge(entry.highestRisk)} | ${riskBadge(entry.highestEUTier)} |`);
    }
    lines.push('');
  }

  // Triggered articles
  if (report.triggeredArticles.length > 0) {
    lines.push('## Triggered EU AI Act Articles');
    lines.push('');
    lines.push('| Article | Reason | Claims |');
    lines.push('|---------|--------|--------|');
    for (const article of report.triggeredArticles) {
      lines.push(`| ${article.article} | ${article.reason} | ${article.claimIds.join(', ')} |`);
    }
    lines.push('');
  }

  // Mitigations
  if (report.mitigations.length > 0) {
    lines.push('## Recommended Mitigations');
    lines.push('');
    for (const m of report.mitigations) {
      lines.push(`- ${m}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by [Faultline](https://github.com/nxtg-ai/faultline-pro) — AI Trust & Safety Platform*');

  return lines.join('\n');
}

function renderAggregatedHtml(report: AggregatedReport): string {
  const cd = report.confidenceDistribution;

  const heatmapRows = report.riskHeatmap.map(e =>
    `<tr>
      <td>${escapeHtml(e.file)}</td>
      <td>${e.findings}</td>
      <td><span class="badge" style="background:${riskColor(e.highestRisk)}">${escapeHtml(e.highestRisk.toUpperCase())}</span></td>
      <td><span class="badge" style="background:${riskColor(e.highestEUTier)}">${escapeHtml(e.highestEUTier.toUpperCase())}</span></td>
    </tr>`
  ).join('\n');

  const articleRows = report.triggeredArticles.map(a =>
    `<tr><td>${escapeHtml(a.article)}</td><td>${escapeHtml(a.reason)}</td><td>${escapeHtml(a.claimIds.join(', '))}</td></tr>`
  ).join('\n');

  const mitigationItems = report.mitigations.map(m => `<li>${escapeHtml(m)}</li>`).join('\n');

  const rs = report.ruleFindingSummary;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Faultline Aggregated Compliance Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 2rem; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
  h2 { font-size: 1.15rem; margin: 1.5rem 0 0.75rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.25rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; font-size: 0.875rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; color: #fff; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
  .summary-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.75rem 1rem; }
  .summary-card .label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .summary-card .value { font-size: 1.25rem; font-weight: 700; margin-top: 0.25rem; }
  ul { padding-left: 1.5rem; margin-bottom: 1rem; }
  li { margin-bottom: 0.35rem; font-size: 0.875rem; }
  footer { margin-top: 2rem; font-size: 0.75rem; color: #94a3b8; text-align: center; }
</style>
</head>
<body>
<h1>Faultline Aggregated Compliance Report</h1>

<div class="summary-grid">
  <div class="summary-card">
    <div class="label">Files Analyzed</div>
    <div class="value">${report.filesAnalyzed}</div>
  </div>
  <div class="summary-card">
    <div class="label">Total Findings</div>
    <div class="value">${report.totalFindings}</div>
  </div>
  <div class="summary-card">
    <div class="label">Overall Risk</div>
    <div class="value"><span class="badge" style="background:${riskColor(report.highestOverallRisk)}">${escapeHtml(report.highestOverallRisk.toUpperCase())}</span></div>
  </div>
  <div class="summary-card">
    <div class="label">EU Risk Tier</div>
    <div class="value"><span class="badge" style="background:${riskColor(report.highestEUTier)}">${escapeHtml(report.highestEUTier.toUpperCase())}</span></div>
  </div>
  <div class="summary-card">
    <div class="label">Total Claims</div>
    <div class="value">${report.totalClaims}</div>
  </div>
  <div class="summary-card">
    <div class="label">Generated</div>
    <div class="value" style="font-size:0.85rem">${escapeHtml(report.generatedAt)}</div>
  </div>
</div>

<h2>EU AI Act Risk Summary</h2>
<table>
  <thead><tr><th>Risk Level</th><th>Count</th></tr></thead>
  <tbody>
    <tr><td><span class="badge" style="background:${riskColor('unacceptable')}">Unacceptable</span></td><td>${report.euRiskSummary.unacceptable}</td></tr>
    <tr><td><span class="badge" style="background:${riskColor('high')}">High</span></td><td>${report.euRiskSummary.high}</td></tr>
    <tr><td><span class="badge" style="background:${riskColor('limited')}">Limited</span></td><td>${report.euRiskSummary.limited}</td></tr>
    <tr><td><span class="badge" style="background:${riskColor('minimal')}">Minimal</span></td><td>${report.euRiskSummary.minimal}</td></tr>
    <tr><td><strong>Total</strong></td><td><strong>${report.euRiskSummary.totalClaims}</strong></td></tr>
  </tbody>
</table>

<h2>Confidence Distribution</h2>
<table>
  <thead><tr><th>Band</th><th>Count</th></tr></thead>
  <tbody>
    <tr><td>High (&ge;0.8)</td><td>${cd.high}</td></tr>
    <tr><td>Medium (0.5&ndash;0.8)</td><td>${cd.medium}</td></tr>
    <tr><td>Low (&lt;0.5)</td><td>${cd.low}</td></tr>
  </tbody>
</table>

${rs.total > 0 ? `<h2>Rule Findings Summary</h2>
<table>
  <thead><tr><th>Severity</th><th>Count</th></tr></thead>
  <tbody>
    <tr><td>Critical</td><td>${rs.bySeverity.critical}</td></tr>
    <tr><td>High</td><td>${rs.bySeverity.high}</td></tr>
    <tr><td>Medium</td><td>${rs.bySeverity.medium}</td></tr>
    <tr><td>Low</td><td>${rs.bySeverity.low}</td></tr>
    <tr><td><strong>Total</strong></td><td><strong>${rs.total}</strong></td></tr>
  </tbody>
</table>` : ''}

${heatmapRows ? `<h2>Risk Heatmap</h2>
<table>
  <thead><tr><th>File</th><th>Findings</th><th>Risk</th><th>EU Tier</th></tr></thead>
  <tbody>${heatmapRows}</tbody>
</table>` : ''}

${articleRows ? `<h2>Triggered EU AI Act Articles</h2>
<table>
  <thead><tr><th>Article</th><th>Reason</th><th>Claims</th></tr></thead>
  <tbody>${articleRows}</tbody>
</table>` : ''}

${mitigationItems ? `<h2>Recommended Mitigations</h2>
<ul>${mitigationItems}</ul>` : ''}

<footer>Generated by Faultline — AI Trust &amp; Safety Platform</footer>
</body>
</html>`;
}

function renderAggregatedSarif(report: AggregatedReport): string {
  // Aggregated SARIF: one run per file in the heatmap
  const runs: Array<{
    tool: { driver: { name: string; version: string; informationUri: string } };
    results: Array<unknown>;
    invocations: Array<{ executionSuccessful: boolean; properties: Record<string, unknown> }>;
  }> = report.riskHeatmap.map(entry => ({
    tool: {
      driver: {
        name: 'Faultline',
        version: '0.1.0',
        informationUri: 'https://github.com/nxtg-ai/faultline-pro',
      },
    },
    results: [] as Array<{
      ruleId: string;
      level: string;
      message: { text: string };
      locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }>;
    }>,
    invocations: [{
      executionSuccessful: true,
      properties: {
        file: entry.file,
        findings: entry.findings,
        highestRisk: entry.highestRisk,
        highestEUTier: entry.highestEUTier,
      },
    }],
  }));

  // Add a summary run with aggregated metadata
  runs.push({
    tool: {
      driver: {
        name: 'Faultline',
        version: '0.1.0',
        informationUri: 'https://github.com/nxtg-ai/faultline-pro',
      },
    },
    results: [],
    invocations: [{
      executionSuccessful: true,
      properties: {
        aggregated: true,
        filesAnalyzed: report.filesAnalyzed,
        totalFindings: report.totalFindings,
        highestOverallRisk: report.highestOverallRisk,
        highestEUTier: report.highestEUTier,
        euRiskSummary: report.euRiskSummary,
        confidenceDistribution: report.confidenceDistribution,
        ruleFindingSummary: report.ruleFindingSummary,
      } as Record<string, unknown>,
    }],
  });

  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0' as const,
    runs,
  };

  return JSON.stringify(sarif, null, 2);
}
