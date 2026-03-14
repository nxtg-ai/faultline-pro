import type { ComplianceReport } from '../compliance/report_generator.js';
import type { ScanResult } from './scan.js';

export type OutputFormat = 'json' | 'markdown' | 'html' | 'sarif';

/**
 * Render a report in the specified format.
 */
export function renderReportAs(data: ScanResult, format: OutputFormat, sarifOptions?: SarifOptions): string {
  switch (format) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'markdown':
      return renderMarkdownReport(data);
    case 'html':
      return renderHtmlReport(data);
    case 'sarif':
      return renderSarifReport(data, sarifOptions);
    default:
      return renderReport(data);
  }
}

/**
 * Render a human-readable plaintext summary from a scan result JSON.
 */
export function renderReport(data: ScanResult): string {
  const lines: string[] = [];
  const report = data.complianceReport;

  lines.push('=== FAULTLINE COMPLIANCE REPORT ===');
  lines.push('');
  lines.push(`Provider:     ${data.provider}`);
  lines.push(`Overall Risk: ${data.overallRisk.toUpperCase()}`);
  lines.push(`EU Risk Tier: ${report.euRiskSummary.highestTier.toUpperCase()}`);
  lines.push(`Generated:    ${report.generatedAt}`);
  lines.push('');

  // Risk summary
  lines.push('--- EU AI Act Risk Summary ---');
  lines.push(`  Unacceptable: ${report.euRiskSummary.unacceptable}`);
  lines.push(`  High:         ${report.euRiskSummary.high}`);
  lines.push(`  Limited:      ${report.euRiskSummary.limited}`);
  lines.push(`  Minimal:      ${report.euRiskSummary.minimal}`);
  lines.push(`  Total Claims: ${report.euRiskSummary.totalClaims}`);
  lines.push('');

  // Confidence distribution
  if (report.confidenceDistribution) {
    const cd = report.confidenceDistribution;
    lines.push('--- Confidence Distribution ---');
    lines.push(`  High (>=0.8):   ${cd.high}`);
    lines.push(`  Medium (0.5-0.8): ${cd.medium}`);
    lines.push(`  Low (<0.5):     ${cd.low}`);
    lines.push('');
  }

  // Claim verifications with confidence scores
  if (Object.keys(data.verifications).length > 0) {
    // Build a lookup of confidence scores from claim mappings
    const scoreMap = new Map<string, number>();
    if (report.claimMappings) {
      for (const m of report.claimMappings) {
        scoreMap.set(m.claimId, m.confidenceScore);
      }
    }

    lines.push('--- Claim Verifications ---');
    for (const [claimId, result] of Object.entries(data.verifications)) {
      const icon =
        result.status === 'supported' ? '[OK]'
        : result.status === 'contradicted' ? '[!!]'
        : result.status === 'mixed' ? '[??]'
        : '[--]';
      const score = scoreMap.get(claimId);
      const scoreSuffix = score !== undefined ? ` (confidence: ${score.toFixed(2)})` : '';
      lines.push(`  ${icon} ${claimId}: ${result.status} — ${result.explanation}${scoreSuffix}`);
    }
    lines.push('');
  }

  // Triggered articles
  if (report.triggeredArticles.length > 0) {
    lines.push('--- Triggered EU AI Act Articles ---');
    for (const article of report.triggeredArticles) {
      lines.push(`  ${article.article}: ${article.reason} (claims: ${article.claimIds.join(', ')})`);
    }
    lines.push('');
  }

  // Mitigations
  if (report.mitigations.length > 0) {
    lines.push('--- Recommended Mitigations ---');
    for (const m of report.mitigations) {
      lines.push(`  * ${m}`);
    }
    lines.push('');
  }

  // Rule findings
  if (data.ruleFindings && data.ruleFindings.length > 0) {
    lines.push('--- Rule Findings ---');
    for (const f of data.ruleFindings) {
      const icon =
        f.severity === 'critical' ? '[!!]'
        : f.severity === 'high' ? '[!]'
        : f.severity === 'medium' ? '[?]'
        : '[--]';
      lines.push(`  ${icon} ${f.ruleId}: ${f.message}`);
    }
    lines.push('');
  }

  lines.push('=== END REPORT ===');
  return lines.join('\n');
}

// --- Risk badge helpers ---

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

function statusIcon(status: string): string {
  switch (status) {
    case 'supported': return '✅';
    case 'contradicted': return '❌';
    case 'mixed': return '⚠️';
    default: return '➖';
  }
}

// --- Markdown renderer ---

function renderMarkdownReport(data: ScanResult): string {
  const report = data.complianceReport;
  const lines: string[] = [];

  lines.push('# Faultline Compliance Report');
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| **Provider** | ${data.provider} |`);
  lines.push(`| **Overall Risk** | ${riskBadge(data.overallRisk)} |`);
  lines.push(`| **EU Risk Tier** | ${riskBadge(report.euRiskSummary.highestTier)} |`);
  lines.push(`| **Generated** | ${report.generatedAt} |`);
  lines.push('');

  // EU AI Act Risk Summary
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
  if (report.confidenceDistribution) {
    const cd = report.confidenceDistribution;
    lines.push('## Confidence Distribution');
    lines.push('');
    lines.push('| Band | Count |');
    lines.push('|------|-------|');
    lines.push(`| High (≥0.8) | ${cd.high} |`);
    lines.push(`| Medium (0.5–0.8) | ${cd.medium} |`);
    lines.push(`| Low (<0.5) | ${cd.low} |`);
    lines.push('');
  }

  // Claim verifications
  const verificationEntries = Object.entries(data.verifications);
  if (verificationEntries.length > 0) {
    const scoreMap = new Map<string, number>();
    if (report.claimMappings) {
      for (const m of report.claimMappings) {
        scoreMap.set(m.claimId, m.confidenceScore);
      }
    }

    lines.push('## Claim Verifications');
    lines.push('');
    lines.push('| Claim | Status | Confidence | Explanation |');
    lines.push('|-------|--------|------------|-------------|');
    for (const [claimId, result] of verificationEntries) {
      const icon = statusIcon(result.status);
      const score = scoreMap.get(claimId);
      const scoreStr = score !== undefined ? score.toFixed(2) : '—';
      lines.push(`| ${claimId} | ${icon} ${result.status} | ${scoreStr} | ${result.explanation} |`);
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

  // Rule findings
  if (data.ruleFindings && data.ruleFindings.length > 0) {
    lines.push('## Rule Findings');
    lines.push('');
    lines.push('| Rule | Severity | Message |');
    lines.push('|------|----------|---------|');
    for (const f of data.ruleFindings) {
      lines.push(`| ${f.ruleId} | ${riskBadge(f.severity)} | ${f.message} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by [Faultline](https://github.com/asifwaliuddin/Faultline) — AI Trust & Safety Platform*');

  return lines.join('\n');
}

// --- HTML renderer ---

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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtmlReport(data: ScanResult): string {
  const report = data.complianceReport;

  const scoreMap = new Map<string, number>();
  if (report.claimMappings) {
    for (const m of report.claimMappings) {
      scoreMap.set(m.claimId, m.confidenceScore);
    }
  }

  const verificationRows = Object.entries(data.verifications).map(([claimId, result]) => {
    const score = scoreMap.get(claimId);
    const scoreStr = score !== undefined ? score.toFixed(2) : '—';
    return `<tr>
      <td>${escapeHtml(claimId)}</td>
      <td><span class="badge" style="background:${riskColor(result.status === 'supported' ? 'low' : result.status === 'contradicted' ? 'critical' : 'medium')}">${escapeHtml(result.status)}</span></td>
      <td>${scoreStr}</td>
      <td>${escapeHtml(result.explanation)}</td>
    </tr>`;
  }).join('\n');

  const articleRows = report.triggeredArticles.map(a =>
    `<tr><td>${escapeHtml(a.article)}</td><td>${escapeHtml(a.reason)}</td><td>${escapeHtml(a.claimIds.join(', '))}</td></tr>`
  ).join('\n');

  const mitigationItems = report.mitigations.map(m => `<li>${escapeHtml(m)}</li>`).join('\n');

  const findingRows = (data.ruleFindings || []).map(f =>
    `<tr><td>${escapeHtml(f.ruleId)}</td><td><span class="badge" style="background:${riskColor(f.severity)}">${escapeHtml(f.severity)}</span></td><td>${escapeHtml(f.message)}</td></tr>`
  ).join('\n');

  const cd = report.confidenceDistribution || { high: 0, medium: 0, low: 0 };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Faultline Compliance Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 2rem; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
  h2 { font-size: 1.15rem; margin: 1.5rem 0 0.75rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.25rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; font-size: 0.875rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; color: #fff; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
  .summary-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.75rem 1rem; }
  .summary-card .label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .summary-card .value { font-size: 1.25rem; font-weight: 700; margin-top: 0.25rem; }
  ul { padding-left: 1.5rem; margin-bottom: 1rem; }
  li { margin-bottom: 0.35rem; font-size: 0.875rem; }
  footer { margin-top: 2rem; font-size: 0.75rem; color: #94a3b8; text-align: center; }
</style>
</head>
<body>
<h1>Faultline Compliance Report</h1>

<div class="summary-grid">
  <div class="summary-card">
    <div class="label">Provider</div>
    <div class="value">${escapeHtml(data.provider)}</div>
  </div>
  <div class="summary-card">
    <div class="label">Overall Risk</div>
    <div class="value"><span class="badge" style="background:${riskColor(data.overallRisk)}">${escapeHtml(data.overallRisk.toUpperCase())}</span></div>
  </div>
  <div class="summary-card">
    <div class="label">EU Risk Tier</div>
    <div class="value"><span class="badge" style="background:${riskColor(report.euRiskSummary.highestTier)}">${escapeHtml(report.euRiskSummary.highestTier.toUpperCase())}</span></div>
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

${verificationRows ? `<h2>Claim Verifications</h2>
<table>
  <thead><tr><th>Claim</th><th>Status</th><th>Confidence</th><th>Explanation</th></tr></thead>
  <tbody>${verificationRows}</tbody>
</table>` : ''}

${articleRows ? `<h2>Triggered EU AI Act Articles</h2>
<table>
  <thead><tr><th>Article</th><th>Reason</th><th>Claims</th></tr></thead>
  <tbody>${articleRows}</tbody>
</table>` : ''}

${mitigationItems ? `<h2>Recommended Mitigations</h2>
<ul>${mitigationItems}</ul>` : ''}

${findingRows ? `<h2>Rule Findings</h2>
<table>
  <thead><tr><th>Rule</th><th>Severity</th><th>Message</th></tr></thead>
  <tbody>${findingRows}</tbody>
</table>` : ''}

<footer>Generated by Faultline — AI Trust &amp; Safety Platform</footer>
</body>
</html>`;
}

// --- SARIF 2.1.0 renderer ---

type SarifLevel = 'error' | 'warning' | 'note' | 'none';

function severityToSarifLevel(severity: string): SarifLevel {
  switch (severity) {
    case 'critical': return 'error';
    case 'high': return 'error';
    case 'medium': return 'warning';
    case 'low': return 'note';
    case 'info': return 'none';
    default: return 'warning';
  }
}

function riskToSarifLevel(risk: string): SarifLevel {
  switch (risk.toLowerCase()) {
    case 'critical':
    case 'unacceptable': return 'error';
    case 'high': return 'error';
    case 'medium':
    case 'limited': return 'warning';
    case 'low':
    case 'minimal': return 'note';
    default: return 'warning';
  }
}

export interface SarifOptions {
  /** File path to use in artifactLocation URIs (defaults to 'input'). */
  inputUri?: string;
}

function renderSarifReport(data: ScanResult, options?: SarifOptions): string {
  const report = data.complianceReport;
  const inputUri = options?.inputUri || 'input';

  // Build rule definitions
  const ruleDefinitions: Array<{
    id: string;
    name: string;
    shortDescription: { text: string };
    fullDescription?: { text: string };
    defaultConfiguration: { level: SarifLevel };
    properties?: Record<string, unknown>;
  }> = [];

  const ruleIdSet = new Set<string>();

  // Rule for each EU AI Act risk tier
  ruleDefinitions.push({
    id: 'faultline/eu-ai-act/unacceptable',
    name: 'EUAIActUnacceptable',
    shortDescription: { text: 'EU AI Act: Unacceptable risk — prohibited AI practice detected' },
    fullDescription: { text: 'Content references AI practices prohibited under Article 5 of the EU AI Act.' },
    defaultConfiguration: { level: 'error' },
    properties: { tags: ['eu-ai-act', 'compliance', 'article-5'] },
  });
  ruleIdSet.add('faultline/eu-ai-act/unacceptable');

  ruleDefinitions.push({
    id: 'faultline/eu-ai-act/high',
    name: 'EUAIActHighRisk',
    shortDescription: { text: 'EU AI Act: High-risk domain detected' },
    fullDescription: { text: 'Content involves a high-risk AI system per Annex III of the EU AI Act.' },
    defaultConfiguration: { level: 'error' },
    properties: { tags: ['eu-ai-act', 'compliance', 'annex-iii'] },
  });
  ruleIdSet.add('faultline/eu-ai-act/high');

  ruleDefinitions.push({
    id: 'faultline/eu-ai-act/limited',
    name: 'EUAIActLimitedRisk',
    shortDescription: { text: 'EU AI Act: Limited risk — transparency obligations apply' },
    fullDescription: { text: 'Content requires AI-generated labelling per Article 50 of the EU AI Act.' },
    defaultConfiguration: { level: 'warning' },
    properties: { tags: ['eu-ai-act', 'compliance', 'article-50'] },
  });
  ruleIdSet.add('faultline/eu-ai-act/limited');

  ruleDefinitions.push({
    id: 'faultline/eu-ai-act/minimal',
    name: 'EUAIActMinimalRisk',
    shortDescription: { text: 'EU AI Act: Minimal risk — voluntary codes of conduct' },
    defaultConfiguration: { level: 'note' },
    properties: { tags: ['eu-ai-act', 'compliance'] },
  });
  ruleIdSet.add('faultline/eu-ai-act/minimal');

  // Rule for claim verification statuses
  ruleDefinitions.push({
    id: 'faultline/verification/contradicted',
    name: 'ClaimContradicted',
    shortDescription: { text: 'Claim contradicted by evidence' },
    defaultConfiguration: { level: 'error' },
    properties: { tags: ['verification', 'claim'] },
  });
  ruleIdSet.add('faultline/verification/contradicted');

  ruleDefinitions.push({
    id: 'faultline/verification/mixed',
    name: 'ClaimMixed',
    shortDescription: { text: 'Claim has mixed evidence' },
    defaultConfiguration: { level: 'warning' },
    properties: { tags: ['verification', 'claim'] },
  });
  ruleIdSet.add('faultline/verification/mixed');

  ruleDefinitions.push({
    id: 'faultline/verification/unverified',
    name: 'ClaimUnverified',
    shortDescription: { text: 'Claim could not be verified' },
    defaultConfiguration: { level: 'warning' },
    properties: { tags: ['verification', 'claim'] },
  });
  ruleIdSet.add('faultline/verification/unverified');

  // Add rule definitions for custom rule findings (PII, bias, toxicity, etc.)
  for (const f of data.ruleFindings || []) {
    // Use the top-level rule category (e.g. "pii" from "pii-email")
    const ruleCategory = `faultline/rule/${f.ruleId}`;
    if (!ruleIdSet.has(ruleCategory)) {
      ruleIdSet.add(ruleCategory);
      ruleDefinitions.push({
        id: ruleCategory,
        name: f.ruleId,
        shortDescription: { text: f.message.split(':')[0] || f.ruleId },
        defaultConfiguration: { level: severityToSarifLevel(f.severity) },
        properties: { tags: ['rule', f.ruleId.split('-')[0]] },
      });
    }
  }

  // Helper: build an artifactLocation with uriBaseId for VS Code SARIF Viewer
  function makeArtifactLocation() {
    return { uri: inputUri, uriBaseId: '%SRCROOT%' };
  }

  // Build results
  const results: Array<Record<string, unknown>> = [];

  const ruleIndexMap = new Map<string, number>();
  ruleDefinitions.forEach((r, i) => ruleIndexMap.set(r.id, i));

  // Build a confidence score lookup
  const scoreMap = new Map<string, number>();
  if (report.claimMappings) {
    for (const m of report.claimMappings) {
      scoreMap.set(m.claimId, m.confidenceScore);
    }
  }

  // Results from claim verifications
  for (const [claimId, vResult] of Object.entries(data.verifications)) {
    if (vResult.status === 'supported') continue; // Only report issues

    const ruleId =
      vResult.status === 'contradicted' ? 'faultline/verification/contradicted'
      : vResult.status === 'mixed' ? 'faultline/verification/mixed'
      : 'faultline/verification/unverified';

    const claim = data.claims.find(c => c.id === claimId);
    const confidence = scoreMap.get(claimId);

    // relatedLocations: link back to the claim text in the source
    const relatedLocations = claim ? [{
      id: 0,
      message: { text: `Claim: ${claim.text}` },
      physicalLocation: {
        artifactLocation: makeArtifactLocation(),
        region: { startLine: 1 },
      },
    }] : undefined;

    // codeFlows: reasoning chain — claim → verification → finding
    const codeFlows = claim ? [{
      message: { text: `Verification chain for ${claimId}` },
      threadFlows: [{
        locations: [
          {
            location: {
              message: { text: `Claim extracted: "${claim.text}"` },
              physicalLocation: {
                artifactLocation: makeArtifactLocation(),
                region: { startLine: 1 },
              },
            },
          },
          {
            location: {
              message: { text: `Verification result: ${vResult.status} — ${vResult.explanation}` },
              physicalLocation: {
                artifactLocation: makeArtifactLocation(),
                region: { startLine: 1 },
              },
            },
          },
        ],
      }],
    }] : undefined;

    results.push({
      ruleId,
      ruleIndex: ruleIndexMap.get(ruleId) ?? -1,
      level: ruleId === 'faultline/verification/contradicted' ? 'error' : 'warning',
      message: { text: `${claimId}: ${vResult.explanation}` },
      locations: [{
        physicalLocation: {
          artifactLocation: makeArtifactLocation(),
          region: { startLine: 1 },
        },
      }],
      ...(relatedLocations && { relatedLocations }),
      ...(codeFlows && { codeFlows }),
      properties: {
        claimId,
        claimText: claim?.text,
        verificationStatus: vResult.status,
        ...(confidence !== undefined && { confidence }),
      },
    });
  }

  // Results from EU AI Act claim mappings
  for (const mapping of report.claimMappings) {
    if (mapping.riskLevel === 'minimal') continue; // Only report non-trivial risk

    const ruleId = `faultline/eu-ai-act/${mapping.riskLevel}`;

    // relatedLocations: link to the original claim
    const relatedLocations = [{
      id: 0,
      message: { text: `Claim: ${mapping.claimText}` },
      physicalLocation: {
        artifactLocation: makeArtifactLocation(),
        region: { startLine: 1 },
      },
    }];

    // codeFlows: claim → EU risk assessment → finding
    const codeFlows = [{
      message: { text: `EU AI Act risk assessment for ${mapping.claimId}` },
      threadFlows: [{
        locations: [
          {
            location: {
              message: { text: `Claim: "${mapping.claimText}"` },
              physicalLocation: {
                artifactLocation: makeArtifactLocation(),
                region: { startLine: 1 },
              },
            },
          },
          {
            location: {
              message: { text: `Matched patterns: ${mapping.matchedPatterns.join(', ')}` },
              physicalLocation: {
                artifactLocation: makeArtifactLocation(),
                region: { startLine: 1 },
              },
            },
          },
          {
            location: {
              message: { text: `EU AI Act risk level: ${mapping.riskLevel}` },
              physicalLocation: {
                artifactLocation: makeArtifactLocation(),
                region: { startLine: 1 },
              },
            },
          },
        ],
      }],
    }];

    results.push({
      ruleId,
      ruleIndex: ruleIndexMap.get(ruleId) ?? -1,
      level: riskToSarifLevel(mapping.riskLevel),
      message: { text: `${mapping.claimId}: EU AI Act ${mapping.riskLevel} risk — ${mapping.matchedPatterns.join(', ')}` },
      locations: [{
        physicalLocation: {
          artifactLocation: makeArtifactLocation(),
          region: { startLine: 1 },
        },
      }],
      relatedLocations,
      codeFlows,
      properties: {
        claimId: mapping.claimId,
        riskLevel: mapping.riskLevel,
        confidence: mapping.confidenceScore,
        matchedPatterns: mapping.matchedPatterns,
      },
    });
  }

  // Results from rule findings (PII, bias, toxicity)
  for (const f of data.ruleFindings || []) {
    const ruleId = `faultline/rule/${f.ruleId}`;
    results.push({
      ruleId,
      ruleIndex: ruleIndexMap.get(ruleId) ?? -1,
      level: severityToSarifLevel(f.severity),
      message: { text: f.message },
      locations: [{
        physicalLocation: {
          artifactLocation: makeArtifactLocation(),
          region: { charOffset: f.offset, charLength: f.match.length },
        },
      }],
      properties: {
        severity: f.severity,
        match: f.match,
      },
    });
  }

  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0' as const,
    runs: [{
      tool: {
        driver: {
          name: 'Faultline',
          version: '0.1.0',
          informationUri: 'https://github.com/awaliuddin/Faultline',
          rules: ruleDefinitions,
        },
      },
      originalUriBaseIds: {
        '%SRCROOT%': { uri: '' },
      },
      results,
      invocations: [{
        executionSuccessful: true,
        properties: {
          provider: data.provider,
          overallRisk: data.overallRisk,
          euHighestTier: report.euRiskSummary.highestTier,
          totalClaims: report.euRiskSummary.totalClaims,
          confidenceDistribution: report.confidenceDistribution,
        },
      }],
    }],
  };

  return JSON.stringify(sarif, null, 2);
}
