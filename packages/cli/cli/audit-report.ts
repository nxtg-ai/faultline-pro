/**
 * `faultline audit-report` — a client record of one scan.
 *
 * The compliance renderers (cli/report.ts, cli/compliance-report.ts) open
 * with an EU AI Act frame. This command does not use them. It does reuse the
 * provenance walk (auditTrail), the not-checkable test, and the customer-safe
 * wording for a provider error (sanitizeVerifyError).
 *
 * Accuracy figures are the score-file values. Published three-decimal
 * roundings are quoted only to say which way they round.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { auditTrail } from './audit-trail.js';
import { isNotCheckable, NOT_CHECKABLE_EXPLANATION } from '../lib/verdict-guard.js';
import { OUT_OF_CREDITS_VERIFY_MESSAGE, sanitizeVerifyError } from '../services/verify-error.js';
import type { VerificationResult } from '../types.js';
import {
  AuditLabelError,
  LABEL_CSV_COLUMNS,
  formatAgreementJson,
  formatAgreementMarkdown,
  importReviewerLabels,
  renderCsvRow,
} from './audit-labels.js';

const require = createRequire(import.meta.url);

function toolVersion(): string {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

export class AuditReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditReportError';
  }
}

export const ACCURACY_READINGS = [
  {
    label: '2026-11-06 Parallel advanced',
    value: '0.7546546546546546',
    ciLow: '0.6778109736738769',
    ciHigh: '0.8294247419247419',
    commit: 'ba11345',
    where: 'hosted',
    scoreFile: 'docs/research/data/parallel-fast-2026-11-06.parallel.summary.json',
    arm: 'parallel',
    writeup: 'docs/research/2026-11-06-parallel-fast-vs-advanced.md',
  },
  {
    label: '2026-11-05 Parallel advanced',
    value: '0.8015015015015015',
    ciLow: '0.7292065619572604',
    ciHigh: '0.8705773562023562',
    commit: '155132b',
    where: 'hosted',
    scoreFile: 'docs/research/data/grounding-arms-2026-11-05.summary.json',
    arm: 'parallel',
    writeup: 'docs/research/2026-11-05-grounding-arms-results.md',
  },
  {
    label: '2026-11-05 not-checkable, before',
    value: '0.7590090090090089',
    ciLow: '0.6806986920348674',
    ciHigh: '0.833567789968652',
    commit: '0a2adb5',
    where: 'local',
    scoreFile: 'docs/research/data/judge-not-checkable-2026-11-05.before.summary.json',
    arm: 'parallel',
    writeup: 'docs/research/2026-11-05-judge-not-checkable-g0.md',
  },
  {
    label: '2026-11-05 not-checkable, after',
    value: '0.7734984984984985',
    ciLow: '0.6976315351315352',
    ciHigh: '0.8486166126713577',
    commit: '61aa917',
    where: 'local',
    scoreFile: 'docs/research/data/judge-not-checkable-2026-11-05.after.summary.json',
    arm: 'parallel',
    writeup: 'docs/research/2026-11-05-judge-not-checkable-g0.md',
  },
] as const;

export const FAST_ARM = {
  value: '0.7189189189189189',
  ciLow: '0.6413061865228092',
  ciHigh: '0.7992254408947487',
  scoreFile: 'docs/research/data/parallel-fast-2026-11-06.parallel-fast.summary.json',
  arm: 'parallel-fast',
} as const;

const BUCKETS = ['supported', 'contradicted', 'mixed', 'unsupported', 'unchecked'] as const;
export type AuditBucket = (typeof BUCKETS)[number];

const INPUT_QUOTE_CAP = 4000;

export interface AuditSource {
  title: string | null;
  uri: string;
  hash: string | null;
  fetchedAt: string | null;
}

export interface AuditClaim {
  id: string;
  text: string;
  type: string;
  importance: number | null;
  bucket: AuditBucket;
  status: 'supported' | 'contradicted' | 'mixed' | 'unverified' | null;
  /** Customer-facing text. Provider payloads are not copied through. */
  explanation: string;
  uncheckedCode: string | null;
  sources: AuditSource[];
  retrievedAt: string | null;
  model: string | null;
  judgeFallback: boolean;
  provider: string | null;
}

export interface TypeCount {
  type: string;
  total: number;
  byBucket: Record<AuditBucket, number>;
}

export interface AuditReportModel {
  version: string;
  provider: string;
  overallRisk: string | null;
  generatedAt: string | null;
  degradedFlag: boolean | null;
  inputSha256: string | null;
  inputChars: number | null;
  inputQuote: string | null;
  inputTruncated: boolean;
  claims: AuditClaim[];
  byBucket: Record<AuditBucket, number>;
  byType: TypeCount[];
  providerErrors: number;
  otherUnchecked: number;
}

const PROVIDER_CODES = new Set([
  'provider_error',
  'provider_out_of_credits',
  'provider_unparseable',
  'output_truncated',
  'rate_limited',
  'provider_unavailable',
  'timeout',
]);

function emptyBuckets(): Record<AuditBucket, number> {
  return { supported: 0, contradicted: 0, mixed: 0, unsupported: 0, unchecked: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isLegacyProviderFailure(explanation: string): boolean {
  return /^Verify failed\b/i.test(explanation.trim());
}

function legacyCode(explanation: string): string {
  const raw = explanation.toLowerCase();
  if (/\b429\b|resource_exhausted|quota|rate[ _-]?limit|free_tier|too many requests/.test(raw)) return 'rate_limited';
  if (/\b5\d\d\b|timeout|timed out|unavailable|503/.test(raw)) return 'provider_unavailable';
  return 'provider_error';
}

function uncheckedCopy(code: string, explanation: string, raw: boolean): string {
  if (code === 'not_verifiable') return NOT_CHECKABLE_EXPLANATION;
  if (code === 'no_record') return 'No verification record for this claim. This is not a verdict.';
  if (code === 'skipped' || code === 'loading') return 'This claim was not sent to verification. This is not a verdict.';
  if (code === 'provider_out_of_credits') return OUT_OF_CREDITS_VERIFY_MESSAGE;
  if (code === 'provider_unparseable') return "The provider's reply could not be read. This claim was not checked. This is not a verdict.";
  if (code === 'output_truncated') return "The provider's reply was cut off at its output limit. This claim was not checked. This is not a verdict.";
  if (raw || !explanation.trim()) return sanitizeVerifyError(explanation || 'provider error');
  return explanation;
}

interface Classified {
  bucket: AuditBucket;
  status: AuditClaim['status'];
  code: string | null;
  explanation: string;
}

function classify(v: Record<string, unknown> | undefined): Classified {
  if (!v) {
    return { bucket: 'unchecked', status: null, code: 'no_record', explanation: uncheckedCopy('no_record', '', true) };
  }
  const explanation = typeof v.explanation === 'string' ? v.explanation : '';
  const legacy = isLegacyProviderFailure(explanation);
  const raw = legacy || explanation.trim().startsWith('{') || explanation.includes('RESOURCE_EXHAUSTED');
  if (isNotCheckable(v)) {
    return { bucket: 'unchecked', status: null, code: 'not_verifiable', explanation: uncheckedCopy('not_verifiable', explanation, false) };
  }
  const status = typeof v.status === 'string' ? v.status : '';
  if (status === 'skipped' || status === 'loading') {
    return { bucket: 'unchecked', status: null, code: status, explanation: uncheckedCopy(status, '', true) };
  }
  if (v.apiError === true || legacy) {
    const reason = typeof v.apiErrorReason === 'string' ? v.apiErrorReason : '';
    const code = reason || (legacy ? legacyCode(explanation) : 'provider_error');
    return { bucket: 'unchecked', status: null, code, explanation: uncheckedCopy(code, explanation, raw) };
  }
  if (status === 'supported' || status === 'contradicted' || status === 'mixed') {
    return { bucket: status, status, code: null, explanation };
  }
  if (status === 'unverified') {
    return { bucket: 'unsupported', status: 'unverified', code: null, explanation };
  }
  return {
    bucket: 'unchecked',
    status: null,
    code: 'no_record',
    explanation: 'No verification record for this claim. This is not a verdict.',
  };
}

function claimFrom(id: string, claim: Record<string, unknown> | undefined, verification: Record<string, unknown> | undefined): AuditClaim {
  const classified = classify(verification);
  const text = typeof claim?.text === 'string' && claim.text.trim() ? claim.text : 'not recorded';
  const type = typeof claim?.type === 'string' && claim.type.trim() ? claim.type : 'not recorded';
  const importance = typeof claim?.importance === 'number' && Number.isFinite(claim.importance) ? claim.importance : null;
  let sources: AuditSource[] = [];
  let retrievedAt: string | null = null;
  let model: string | null = null;
  let judgeFallback = false;
  let provider: string | null = null;
  if (verification && classified.bucket !== 'unchecked') {
    const trail = auditTrail(verification as unknown as VerificationResult);
    sources = trail.sources.map((s) => ({
      title: s.title,
      uri: s.uri,
      hash: s.evidence?.contentSha256 ?? null,
      fetchedAt: s.evidence?.fetchedAt ?? null,
    }));
    retrievedAt = trail.provenance?.retrievedAt ?? null;
    model = trail.provenance?.model ?? null;
    judgeFallback = trail.provenance?.judgeFallback === true;
    provider = trail.provenance?.provider ?? null;
  }
  return {
    id,
    text,
    type,
    importance,
    bucket: classified.bucket,
    status: classified.status,
    explanation: classified.explanation,
    uncheckedCode: classified.code,
    sources,
    retrievedAt,
    model,
    judgeFallback,
    provider,
  };
}

export function buildAuditReport(scan: unknown): AuditReportModel {
  const root = asRecord(scan);
  if (!root) throw new AuditReportError('Scan result must be a JSON object.');

  const claimList = Array.isArray(root.claims) ? root.claims : [];
  const verifications = asRecord(root.verifications) ?? {};
  const seen = new Set<string>();
  const claims: AuditClaim[] = [];

  claimList.forEach((entry, index) => {
    const claim = asRecord(entry) ?? undefined;
    const rawId = typeof claim?.id === 'string' ? claim.id.trim() : '';
    const id = rawId || `missing-id-${index + 1}`;
    seen.add(id);
    const verification = asRecord(verifications[id]) ?? undefined;
    claims.push(claimFrom(id, claim, verification));
  });

  for (const id of Object.keys(verifications).sort()) {
    if (seen.has(id)) continue;
    claims.push(claimFrom(id, undefined, asRecord(verifications[id]) ?? undefined));
  }

  const byBucket = emptyBuckets();
  for (const c of claims) byBucket[c.bucket]++;

  const typeOrder: string[] = ['fact', 'opinion', 'interpretation'];
  for (const c of claims) if (!typeOrder.includes(c.type)) typeOrder.push(c.type);
  const byType: TypeCount[] = typeOrder.map((type) => {
    const rows = claims.filter((c) => c.type === type);
    const buckets = emptyBuckets();
    for (const c of rows) buckets[c.bucket]++;
    return { type, total: rows.length, byBucket: buckets };
  });

  let providerErrors = 0;
  let otherUnchecked = 0;
  for (const c of claims) {
    if (c.bucket !== 'unchecked') continue;
    if (c.uncheckedCode && PROVIDER_CODES.has(c.uncheckedCode)) providerErrors++;
    else otherUnchecked++;
  }

  const input = typeof root.input === 'string' ? root.input : null;
  const compliance = asRecord(root.complianceReport);
  const generatedAt = typeof compliance?.generatedAt === 'string' ? compliance.generatedAt : null;
  const degradedFlag = typeof root.degraded === 'boolean' ? root.degraded : null;

  return {
    version: toolVersion(),
    provider: typeof root.provider === 'string' && root.provider.trim() ? root.provider : 'not recorded',
    overallRisk: typeof root.overallRisk === 'string' ? root.overallRisk : null,
    generatedAt,
    degradedFlag,
    inputSha256: input === null ? null : createHash('sha256').update(input, 'utf8').digest('hex'),
    inputChars: input === null ? null : [...input].length,
    inputQuote: input === null ? null : input.slice(0, INPUT_QUOTE_CAP),
    inputTruncated: input !== null && input.length > INPUT_QUOTE_CAP,
    claims,
    byBucket,
    byType,
    providerErrors,
    otherUnchecked,
  };
}

export function methodParagraphs(): string[] {
  return [
    'This report was rendered from the scan file only. It did not call a model or a search service.',
    'Claims are the scan\'s claims, in file order. A verification id with no claim is listed after those.',
    'A checked verdict is supported, contradicted, mixed, or unverified. Unverified means the check ran and the scan recorded no support; this report calls that unsupported.',
    'A claim is unchecked when it has no verification record, its status is skipped or loading, the record has apiError, the record has notCheckable, or the explanation begins with "Verify failed" (the engine\'s wording for a provider error, including files saved before apiError was set). An unchecked claim is not a verdict.',
    'Sources, retrieval time, model and passage hash are copied from the verification. Retrieval time is provenance.retrievedAt when the scan recorded it, otherwise the time a cited page was fetched. The passage hash is the SHA-256 of the page bytes the scan fetched (evidence.contentSha256). A field the scan did not record is written as "not recorded". Nothing in those columns is inferred.',
  ];
}

export function limitationParagraphs(): string[] {
  const headline = ACCURACY_READINGS[0];
  return [
    'Faultline\'s verdict accuracy was measured on a labelled set. The measurement was not pre-registered. The figure this report quotes for the hosted path is balanced accuracy on the 193 Factcheck-Bench claims, in a 200-claim sample, that have a true or false gold label. The hosted path is Parallel search in advanced mode, then a Gemini judge with no Google search tool. The judge model is gemini-2.5-flash. The engine commit is ba11345.',
    'Balanced accuracy is the mean of recall on true claims and recall on false claims. Supported counts as true and contradicted as false. Mixed, unverified and a failed check count as wrong. The interval is a 2,000-resample bootstrap, seed 20260929, from scripts/accuracy-g0-score.py.',
    `The score file ${headline.scoreFile} records balanced accuracy ${headline.value}, 95% CI [${headline.ciLow}, ${headline.ciHigh}]. README.md and the changelog print this as 0.755 [0.678, 0.829]. That three-decimal form rounds the point estimate and the lower bound up, and rounds the upper bound down. This report quotes the score file.`,
    'Four readings of the same 200-claim sample are in the repo from 2026-11-05 and 2026-11-06. README.md describes them as 0.755 to 0.802. That range rounds the lowest of the four up and the highest up. The score-file values are in the table. They are not pooled into one interval. Two of the four were local API servers, not the hosted engine.',
    `On 2026-11-06 a fast-mode arm, which is not the production setting, scored ${FAST_ARM.value}, 95% CI [${FAST_ARM.ciLow}, ${FAST_ARM.ciHigh}] (${FAST_ARM.scoreFile}). The write-up kept advanced mode.`,
    'This scan is not that measurement. The interval does not apply to a different provider, a different model, a local key, or to the claims in this file. An unchecked claim has no verdict, so it sits outside the figure. Rule findings stored on the scan are not part of this report. This document does not assess regulatory obligations.',
  ];
}

/** Search time when the scan stored one; otherwise the page-fetch time, labelled as such. */
function retrievedText(c: AuditClaim): string {
  if (c.retrievedAt) return c.retrievedAt;
  const fetched = [...new Set(c.sources.map((s) => s.fetchedAt).filter((t): t is string => !!t))];
  if (fetched.length === 0) return 'not recorded';
  return fetched.map((t) => `page fetched ${t}`).join('; ');
}

function modelText(c: AuditClaim): string {
  if (!c.model) return 'not recorded';
  return c.judgeFallback ? `${c.model} (fallback model)` : c.model;
}

function sourceText(c: AuditClaim): string {
  if (c.sources.length === 0) return 'not recorded';
  return c.sources.map((s) => (s.title ? `${s.title} (${s.uri})` : s.uri)).join('; ');
}

function hashText(c: AuditClaim): string {
  const withHash = c.sources.filter((s) => s.hash);
  if (withHash.length === 0) return 'not recorded';
  const body = withHash.map((s) => (c.sources.length > 1 ? `${s.hash} (${s.uri})` : s.hash!)).join('; ');
  const missing = c.sources.length - withHash.length;
  return missing > 0 ? `${body}; ${missing} source${missing === 1 ? '' : 's'} with no passage hash` : body;
}

function hashList(c: AuditClaim): string {
  return c.sources.map((s) => s.hash).filter((h): h is string => !!h).join(' | ');
}

function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function mdCell(s: string): string {
  // Escape the backslash first. Replacing "|" with "\|" alone leaves a
  // backslash in the claim able to escape the pipe that follows it.
  return flat(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function fence(text: string): string {
  const body = text.includes('```') ? text.replace(/```/g, "'''") : text;
  return '~~~~\n' + body + '\n~~~~';
}

function findings(model: AuditReportModel, buckets: AuditBucket[]): AuditClaim[] {
  return model.claims.filter((c) => buckets.includes(c.bucket));
}

export function renderAuditMarkdown(model: AuditReportModel): string {
  const lines: string[] = [];
  lines.push('# AI output audit');
  lines.push('');
  lines.push('Claim-level record of one Faultline scan. Prepared from the scan file alone.');
  lines.push('');
  if (model.providerErrors > 0) {
    lines.push('This scan left claims unchecked after a provider error. An unchecked claim is not a finding that the claim is unsupported.');
    lines.push('');
  }

  lines.push('## Scope');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Renderer | Faultline ${model.version} |`);
  lines.push(`| Provider recorded | ${mdCell(model.provider)} |`);
  lines.push(`| Risk band recorded by the scan | ${model.overallRisk ? mdCell(model.overallRisk) : 'not recorded'} |`);
  lines.push(`| Scan timestamp recorded | ${model.generatedAt ? mdCell(model.generatedAt) : 'not recorded'} |`);
  lines.push(`| Input characters (Unicode code points) | ${model.inputChars === null ? 'not recorded' : String(model.inputChars)} |`);
  lines.push(`| Input SHA-256 | ${model.inputSha256 ?? 'not recorded'} |`);
  lines.push(`| Claims | ${model.claims.length} |`);
  lines.push(`| Unchecked after a provider error | ${model.providerErrors} |`);
  lines.push(`| Unchecked for another reason | ${model.otherUnchecked} |`);
  lines.push(`| Scan file degraded flag | ${model.degradedFlag === null ? 'not recorded' : model.degradedFlag ? 'true' : 'false'} |`);
  lines.push('');
  if (model.inputQuote === null) {
    lines.push('The scan file has no input text.');
  } else {
    lines.push(model.inputTruncated
      ? `The input is ${model.inputChars} characters. The first ${INPUT_QUOTE_CAP} are quoted. The SHA-256 covers the whole input.`
      : 'Input text, as stored on the scan:');
    lines.push('');
    lines.push(fence(model.inputQuote));
  }
  lines.push('');

  lines.push('## Method');
  lines.push('');
  for (const p of methodParagraphs()) {
    lines.push(p);
    lines.push('');
  }

  lines.push('## Counts by verdict');
  lines.push('');
  lines.push('| Verdict | Count |');
  lines.push('|---------|------:|');
  lines.push(`| supported | ${model.byBucket.supported} |`);
  lines.push(`| contradicted | ${model.byBucket.contradicted} |`);
  lines.push(`| mixed | ${model.byBucket.mixed} |`);
  lines.push(`| unsupported (checked, no support recorded) | ${model.byBucket.unsupported} |`);
  lines.push(`| unchecked (not a verdict) | ${model.byBucket.unchecked} |`);
  lines.push(`| total claims | ${model.claims.length} |`);
  lines.push('');

  lines.push('## Counts by claim type');
  lines.push('');
  lines.push('| Type | Claims | supported | contradicted | mixed | unsupported | unchecked |');
  lines.push('|------|-------:|-----------:|-------------:|------:|-------------:|----------:|');
  for (const row of model.byType) {
    const b = row.byBucket;
    lines.push(`| ${mdCell(row.type)} | ${row.total} | ${b.supported} | ${b.contradicted} | ${b.mixed} | ${b.unsupported} | ${b.unchecked} |`);
  }
  lines.push('');

  lines.push('## Unsupported and contradicted claims');
  lines.push('');
  const adverse = findings(model, ['unsupported', 'contradicted']);
  if (adverse.length === 0) {
    lines.push('None. The scan recorded no contradicted claim and no claim that was checked and left unsupported.');
    lines.push('');
  } else {
    lines.push('| Claim | Status | Sources | Retrieved | Model | Passage SHA-256 |');
    lines.push('|-------|--------|---------|-----------|-------|-----------------|');
    for (const c of adverse) {
      const claim = `${c.id} — ${flat(c.text)} Recorded explanation: ${flat(c.explanation) || 'not recorded'}`;
      lines.push(`| ${mdCell(claim)} | ${c.bucket} | ${mdCell(sourceText(c))} | ${mdCell(retrievedText(c))} | ${mdCell(modelText(c))} | ${mdCell(hashText(c))} |`);
    }
    lines.push('');
  }

  lines.push('## Mixed claims');
  lines.push('');
  const mixed = findings(model, ['mixed']);
  if (mixed.length === 0) {
    lines.push('None.');
    lines.push('');
  } else {
    lines.push('| Claim | Sources | Retrieved | Model | Passage SHA-256 |');
    lines.push('|-------|---------|-----------|-------|-----------------|');
    for (const c of mixed) {
      const claim = `${c.id} — ${flat(c.text)} Recorded explanation: ${flat(c.explanation) || 'not recorded'}`;
      lines.push(`| ${mdCell(claim)} | ${mdCell(sourceText(c))} | ${mdCell(retrievedText(c))} | ${mdCell(modelText(c))} | ${mdCell(hashText(c))} |`);
    }
    lines.push('');
  }

  lines.push('## Unchecked claims');
  lines.push('');
  const unchecked = findings(model, ['unchecked']);
  if (unchecked.length === 0) {
    lines.push('None. Every claim in the file has a checked verdict.');
    lines.push('');
  } else {
    lines.push('These claims were not checked. They are listed apart from unsupported and contradicted claims.');
    lines.push('');
    lines.push('| Claim | Why it was not checked |');
    lines.push('|-------|------------------------|');
    for (const c of unchecked) {
      lines.push(`| ${mdCell(`${c.id} — ${c.text}`)} | ${mdCell(c.explanation)} |`);
    }
    lines.push('');
  }

  lines.push('## Limitations');
  lines.push('');
  for (const p of limitationParagraphs()) {
    lines.push(p);
    lines.push('');
  }
  lines.push('| Reading | Balanced accuracy | 95% CI | Commit | Where | Score file |');
  lines.push('|---------|-------------------|--------|--------|-------|------------|');
  for (const r of ACCURACY_READINGS) {
    lines.push(`| ${r.label} | ${r.value} | [${r.ciLow}, ${r.ciHigh}] | ${r.commit} | ${r.where} | ${r.scoreFile} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlParas(paragraphs: string[]): string {
  return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
}

export function renderAuditHtml(model: AuditReportModel): string {
  const adverse = findings(model, ['unsupported', 'contradicted']);
  const mixed = findings(model, ['mixed']);
  const unchecked = findings(model, ['unchecked']);
  const adverseRows = adverse.length === 0
    ? '<p>None. The scan recorded no contradicted claim and no claim that was checked and left unsupported.</p>'
    : `<table>
<thead><tr><th>Claim</th><th>Status</th><th>Sources</th><th>Retrieved</th><th>Model</th><th>Passage SHA-256</th></tr></thead>
<tbody>
${adverse.map((c) => `<tr><td><strong>${escapeHtml(c.id)}</strong> ${escapeHtml(flat(c.text))}<br>Recorded explanation: ${escapeHtml(flat(c.explanation) || 'not recorded')}</td><td>${escapeHtml(c.bucket)}</td><td>${escapeHtml(sourceText(c))}</td><td>${escapeHtml(retrievedText(c))}</td><td>${escapeHtml(modelText(c))}</td><td>${escapeHtml(hashText(c))}</td></tr>`).join('\n')}
</tbody></table>`;
  const mixedBlock = mixed.length === 0
    ? '<p>None.</p>'
    : `<table>
<thead><tr><th>Claim</th><th>Sources</th><th>Retrieved</th><th>Model</th><th>Passage SHA-256</th></tr></thead>
<tbody>
${mixed.map((c) => `<tr><td><strong>${escapeHtml(c.id)}</strong> ${escapeHtml(flat(c.text))}<br>Recorded explanation: ${escapeHtml(flat(c.explanation) || 'not recorded')}</td><td>${escapeHtml(sourceText(c))}</td><td>${escapeHtml(retrievedText(c))}</td><td>${escapeHtml(modelText(c))}</td><td>${escapeHtml(hashText(c))}</td></tr>`).join('\n')}
</tbody></table>`;
  const uncheckedBlock = unchecked.length === 0
    ? '<p>None. Every claim in the file has a checked verdict.</p>'
    : `<p>These claims were not checked. They are listed apart from unsupported and contradicted claims.</p>
<table>
<thead><tr><th>Claim</th><th>Why it was not checked</th></tr></thead>
<tbody>
${unchecked.map((c) => `<tr><td><strong>${escapeHtml(c.id)}</strong> ${escapeHtml(flat(c.text))}</td><td>${escapeHtml(c.explanation)}</td></tr>`).join('\n')}
</tbody></table>`;
  const inputBlock = model.inputQuote === null
    ? '<p>The scan file has no input text.</p>'
    : `<p>${model.inputTruncated
      ? `The input is ${model.inputChars} characters. The first ${INPUT_QUOTE_CAP} are quoted. The SHA-256 covers the whole input.`
      : 'Input text, as stored on the scan:'}</p>
<pre>${escapeHtml(model.inputQuote)}</pre>`;
  const banner = model.providerErrors > 0
    ? '<p class="banner">This scan left claims unchecked after a provider error. An unchecked claim is not a finding that the claim is unsupported.</p>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AI output audit</title>
<style>
  body { font: 15px/1.45 Georgia, "Times New Roman", serif; color: #1a1a1a; max-width: 960px; margin: 2rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.6rem; font-weight: 600; margin-bottom: 0.25rem; }
  h2 { font-size: 1.15rem; margin-top: 1.75rem; border-bottom: 1px solid #ccc; padding-bottom: 0.2rem; }
  table { border-collapse: collapse; width: 100%; margin: 0.75rem 0 1rem; word-break: break-word; }
  th, td { border: 1px solid #ccc; padding: 0.35rem 0.5rem; vertical-align: top; text-align: left; }
  th { background: #f4f4f4; }
  .banner { background: #f7f3e8; border: 1px solid #e0d2a8; padding: 0.6rem 0.8rem; }
  pre { white-space: pre-wrap; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f6f6f6; padding: 0.75rem; }
</style>
</head>
<body>
<h1>AI output audit</h1>
<p>Claim-level record of one Faultline scan. Prepared from the scan file alone.</p>
${banner}
<h2>Scope</h2>
<table>
<tbody>
<tr><th>Renderer</th><td>Faultline ${escapeHtml(model.version)}</td></tr>
<tr><th>Provider recorded</th><td>${escapeHtml(model.provider)}</td></tr>
<tr><th>Risk band recorded by the scan</th><td>${escapeHtml(model.overallRisk ?? 'not recorded')}</td></tr>
<tr><th>Scan timestamp recorded</th><td>${escapeHtml(model.generatedAt ?? 'not recorded')}</td></tr>
<tr><th>Input characters (Unicode code points)</th><td>${model.inputChars === null ? 'not recorded' : String(model.inputChars)}</td></tr>
<tr><th>Input SHA-256</th><td>${escapeHtml(model.inputSha256 ?? 'not recorded')}</td></tr>
<tr><th>Claims</th><td>${model.claims.length}</td></tr>
<tr><th>Unchecked after a provider error</th><td>${model.providerErrors}</td></tr>
<tr><th>Unchecked for another reason</th><td>${model.otherUnchecked}</td></tr>
<tr><th>Scan file degraded flag</th><td>${model.degradedFlag === null ? 'not recorded' : model.degradedFlag ? 'true' : 'false'}</td></tr>
</tbody>
</table>
${inputBlock}
<h2>Method</h2>
${htmlParas(methodParagraphs())}
<h2>Counts by verdict</h2>
<table>
<thead><tr><th>Verdict</th><th>Count</th></tr></thead>
<tbody>
<tr><td>supported</td><td>${model.byBucket.supported}</td></tr>
<tr><td>contradicted</td><td>${model.byBucket.contradicted}</td></tr>
<tr><td>mixed</td><td>${model.byBucket.mixed}</td></tr>
<tr><td>unsupported (checked, no support recorded)</td><td>${model.byBucket.unsupported}</td></tr>
<tr><td>unchecked (not a verdict)</td><td>${model.byBucket.unchecked}</td></tr>
<tr><td>total claims</td><td>${model.claims.length}</td></tr>
</tbody>
</table>
<h2>Counts by claim type</h2>
<table>
<thead><tr><th>Type</th><th>Claims</th><th>supported</th><th>contradicted</th><th>mixed</th><th>unsupported</th><th>unchecked</th></tr></thead>
<tbody>
${model.byType.map((row) => `<tr><td>${escapeHtml(row.type)}</td><td>${row.total}</td><td>${row.byBucket.supported}</td><td>${row.byBucket.contradicted}</td><td>${row.byBucket.mixed}</td><td>${row.byBucket.unsupported}</td><td>${row.byBucket.unchecked}</td></tr>`).join('\n')}
</tbody>
</table>
<h2>Unsupported and contradicted claims</h2>
${adverseRows}
<h2>Mixed claims</h2>
${mixedBlock}
<h2>Unchecked claims</h2>
${uncheckedBlock}
<h2>Limitations</h2>
${htmlParas(limitationParagraphs())}
<table>
<thead><tr><th>Reading</th><th>Balanced accuracy</th><th>95% CI</th><th>Commit</th><th>Where</th><th>Score file</th></tr></thead>
<tbody>
${ACCURACY_READINGS.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${r.value}</td><td>[${r.ciLow}, ${r.ciHigh}]</td><td>${escapeHtml(r.commit)}</td><td>${escapeHtml(r.where)}</td><td>${escapeHtml(r.scoreFile)}</td></tr>`).join('\n')}
</tbody>
</table>
</body>
</html>
`;
}

/** Standard-font PDFs cannot carry every Unicode scalar. Map the ones that matter; replace the rest. */
export function pdfSafe(s: string): string {
  return s
    .replace(/\u2014|\u2013/g, '-')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
    .replace(/[^\n\r\t\x20-\x7E\u00A0-\u00FF]/g, '?');
}

function pdfStamp(generatedAt: string | null): Date {
  if (generatedAt) {
    const d = new Date(generatedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date('2026-11-17T00:00:00.000Z');
}

export async function renderAuditPdf(model: AuditReportModel): Promise<Buffer> {
  const PDFDocumentModule = await import('pdfkit');
  const PDFDocument = PDFDocumentModule.default;
  const stamp = pdfStamp(model.generatedAt);

  return new Promise((resolvePromise, reject) => {
    const doc = new PDFDocument({
      margin: 56,
      size: 'A4',
      compress: false,
      info: {
        Title: 'AI output audit',
        Author: 'Faultline',
        Creator: 'Faultline',
        Producer: 'Faultline',
        CreationDate: stamp,
        ModDate: stamp,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolvePromise(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - 112;
    const write = (text: string, opts?: { size?: number; bold?: boolean; gap?: number }) => {
      if (doc.y > doc.page.height - 72) doc.addPage();
      doc.font(opts?.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(opts?.size ?? 10)
        .fillColor('#1a1a1a')
        .text(pdfSafe(text), { width });
      if (opts?.gap) doc.moveDown(opts.gap);
    };

    write('AI output audit', { size: 18, bold: true, gap: 0.3 });
    write('Claim-level record of one Faultline scan. Prepared from the scan file alone.', { gap: 0.6 });
    if (model.providerErrors > 0) {
      write('This scan left claims unchecked after a provider error. An unchecked claim is not a finding that the claim is unsupported.', { gap: 0.6 });
    }

    write('Scope', { size: 13, bold: true, gap: 0.3 });
    const scope: Array<[string, string]> = [
      ['Renderer', `Faultline ${model.version}`],
      ['Provider recorded', model.provider],
      ['Risk band recorded by the scan', model.overallRisk ?? 'not recorded'],
      ['Scan timestamp recorded', model.generatedAt ?? 'not recorded'],
      ['Input characters (Unicode code points)', model.inputChars === null ? 'not recorded' : String(model.inputChars)],
      ['Input SHA-256', model.inputSha256 ?? 'not recorded'],
      ['Claims', String(model.claims.length)],
      ['Unchecked after a provider error', String(model.providerErrors)],
      ['Unchecked for another reason', String(model.otherUnchecked)],
      ['Scan file degraded flag', model.degradedFlag === null ? 'not recorded' : String(model.degradedFlag)],
    ];
    for (const [k, v] of scope) write(`${k}: ${v}`);
    doc.moveDown(0.4);
    if (model.inputQuote === null) write('The scan file has no input text.', { gap: 0.4 });
    else {
      write(model.inputTruncated
        ? `The input is ${model.inputChars} characters. The first ${INPUT_QUOTE_CAP} are quoted. The SHA-256 covers the whole input.`
        : 'Input text, as stored on the scan:');
      write(model.inputQuote, { gap: 0.4 });
    }

    write('Method', { size: 13, bold: true, gap: 0.3 });
    for (const p of methodParagraphs()) write(p, { gap: 0.3 });

    write('Counts by verdict', { size: 13, bold: true, gap: 0.3 });
    write(`supported: ${model.byBucket.supported}`);
    write(`contradicted: ${model.byBucket.contradicted}`);
    write(`mixed: ${model.byBucket.mixed}`);
    write(`unsupported (checked, no support recorded): ${model.byBucket.unsupported}`);
    write(`unchecked (not a verdict): ${model.byBucket.unchecked}`);
    write(`total claims: ${model.claims.length}`, { gap: 0.4 });

    write('Counts by claim type', { size: 13, bold: true, gap: 0.3 });
    for (const row of model.byType) {
      const b = row.byBucket;
      write(`${row.type}: ${row.total} claims (supported ${b.supported}, contradicted ${b.contradicted}, mixed ${b.mixed}, unsupported ${b.unsupported}, unchecked ${b.unchecked})`);
    }
    doc.moveDown(0.4);

    write('Unsupported and contradicted claims', { size: 13, bold: true, gap: 0.3 });
    const adverse = findings(model, ['unsupported', 'contradicted']);
    if (adverse.length === 0) {
      write('None. The scan recorded no contradicted claim and no claim that was checked and left unsupported.', { gap: 0.4 });
    } else {
      for (const c of adverse) {
        write(`${c.id} — ${c.bucket}`, { bold: true });
        write(flat(c.text));
        write(`Recorded explanation: ${flat(c.explanation) || 'not recorded'}`);
        write(`Sources: ${sourceText(c)}`);
        write(`Retrieved: ${retrievedText(c)}`);
        write(`Model: ${modelText(c)}`);
        write(`Passage SHA-256: ${hashText(c)}`, { gap: 0.4 });
      }
    }

    write('Mixed claims', { size: 13, bold: true, gap: 0.3 });
    const mixed = findings(model, ['mixed']);
    if (mixed.length === 0) write('None.', { gap: 0.4 });
    else {
      for (const c of mixed) {
        write(`${c.id} — mixed`, { bold: true });
        write(flat(c.text));
        write(`Recorded explanation: ${flat(c.explanation) || 'not recorded'}`);
        write(`Sources: ${sourceText(c)}`);
        write(`Retrieved: ${retrievedText(c)}`);
        write(`Model: ${modelText(c)}`);
        write(`Passage SHA-256: ${hashText(c)}`, { gap: 0.4 });
      }
    }

    write('Unchecked claims', { size: 13, bold: true, gap: 0.3 });
    const unchecked = findings(model, ['unchecked']);
    if (unchecked.length === 0) write('None. Every claim in the file has a checked verdict.', { gap: 0.4 });
    else {
      write('These claims were not checked. They are listed apart from unsupported and contradicted claims.', { gap: 0.3 });
      for (const c of unchecked) {
        write(`${c.id}`, { bold: true });
        write(flat(c.text));
        write(c.explanation, { gap: 0.3 });
      }
    }

    write('Limitations', { size: 13, bold: true, gap: 0.3 });
    for (const p of limitationParagraphs()) write(p, { gap: 0.3 });
    for (const r of ACCURACY_READINGS) {
      write(`${r.label}: balanced accuracy ${r.value}, 95% CI [${r.ciLow}, ${r.ciHigh}], commit ${r.commit}, ${r.where}. ${r.scoreFile}`);
    }

    doc.end();
  });
}

export function renderLabelCsv(model: AuditReportModel): string {
  const lines = [renderCsvRow([...LABEL_CSV_COLUMNS])];
  for (const c of model.claims) {
    lines.push(renderCsvRow([
      c.id,
      c.text,
      c.type,
      c.importance ?? '',
      c.status ?? '',
      c.bucket,
      c.uncheckedCode ?? '',
      c.explanation,
      c.sources.map((s) => s.uri).join(' | '),
      c.sources.map((s) => s.title ?? '').filter(Boolean).join(' | '),
      c.retrievedAt ?? '',
      modelText(c) === 'not recorded' ? '' : modelText(c),
      c.provider ?? '',
      hashList(c),
      '',
      '',
      '',
    ]));
  }
  return lines.join('\n') + '\n';
}

export function reportFormat(filePath: string): 'markdown' | 'html' | 'pdf' | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.pdf') return 'pdf';
  return null;
}

function summary(model: AuditReportModel): string {
  const b = model.byBucket;
  return `Claims: ${model.claims.length}. Supported: ${b.supported}. Contradicted: ${b.contradicted}. Mixed: ${b.mixed}. Unsupported: ${b.unsupported}. Unchecked: ${b.unchecked}.`;
}

export async function runAuditReport(flags: Record<string, string>): Promise<{ exitCode: number; output: string }> {
  try {
    if (flags['import-labels']) {
      if (flags['scan'] || flags['labels-out']) {
        return { exitCode: 1, output: 'Error: --import-labels reads a labelled CSV and does not take --scan or --labels-out.' };
      }
      const src = resolve(flags['import-labels']);
      if (!existsSync(src)) return { exitCode: 1, output: `Error: file not found: ${flags['import-labels']}` };
      const result = importReviewerLabels(readFileSync(src, 'utf8'));
      const out = flags['out'];
      if (!out) return { exitCode: 0, output: formatAgreementMarkdown(result) };
      const ext = extname(out).toLowerCase();
      if (ext === '.json') {
        writeFileSync(resolve(out), formatAgreementJson(result), 'utf8');
        return { exitCode: 0, output: agreementSummary(result, resolve(out)) };
      }
      if (ext === '.md' || ext === '.markdown') {
        writeFileSync(resolve(out), formatAgreementMarkdown(result), 'utf8');
        return { exitCode: 0, output: agreementSummary(result, resolve(out)) };
      }
      return { exitCode: 1, output: 'Error: --out for --import-labels must end in .md or .json.' };
    }

    if (!flags['scan']) {
      return {
        exitCode: 1,
        output: 'Error: --scan <result.json> is required.\n\nUsage: faultline audit-report --scan result.json --out report.md',
      };
    }
    if (!flags['out'] && !flags['labels-out']) {
      return { exitCode: 1, output: 'Error: provide --out <report.html|md|pdf> or --labels-out <claims.csv>, or both.' };
    }
    const scanPath = resolve(flags['scan']);
    if (!existsSync(scanPath)) return { exitCode: 1, output: `Error: file not found: ${flags['scan']}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(scanPath, 'utf8'));
    } catch {
      return { exitCode: 1, output: `Error: could not parse scan result JSON from ${flags['scan']}` };
    }
    const format = flags['out'] ? reportFormat(flags['out']) : null;
    if (flags['out'] && !format) {
      return { exitCode: 1, output: 'Error: --out must end in .html, .md, or .pdf. Reviewer CSV is --labels-out.' };
    }
    const model = buildAuditReport(parsed);
    const notes: string[] = [];

    if (flags['labels-out']) {
      const dest = resolve(flags['labels-out']);
      writeFileSync(dest, renderLabelCsv(model), 'utf8');
      notes.push(`Wrote reviewer CSV to ${dest}`);
    }
    if (flags['out'] && format) {
      const dest = resolve(flags['out']);
      if (format === 'pdf') writeFileSync(dest, await renderAuditPdf(model));
      else if (format === 'html') writeFileSync(dest, renderAuditHtml(model), 'utf8');
      else writeFileSync(dest, renderAuditMarkdown(model), 'utf8');
      notes.push(`Wrote AI output audit (${format}) to ${dest}`);
    }
    notes.push(summary(model));
    return { exitCode: 0, output: notes.join('\n') };
  } catch (err) {
    if (err instanceof AuditReportError || err instanceof AuditLabelError) {
      return { exitCode: 1, output: `Error: ${err.message}` };
    }
    throw err;
  }
}

function agreementSummary(result: ReturnType<typeof importReviewerLabels>, dest: string): string {
  const rate = result.errorRate === null
    ? 'The error rate was not computed. No checked claim had a usable reviewer label.'
    : `Error rate ${result.errors}/${result.scored} = ${String(result.errorRate)}, 95% CI [${String(result.errorRateCi95?.[0])}, ${String(result.errorRateCi95?.[1])}].`;
  return `Wrote reviewer agreement to ${dest}\n${rate}`;
}
