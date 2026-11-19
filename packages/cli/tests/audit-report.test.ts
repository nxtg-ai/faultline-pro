import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { main } from '../cli/index';
import { NOT_CHECKABLE_EXPLANATION } from '../lib/verdict-guard';
import {
  ACCURACY_READINGS,
  FAST_ARM,
  HEADLINE_MEASUREMENT,
  PRODUCTION_JUDGE_CHANGE,
  buildAuditReport,
  limitationParagraphs,
  renderAuditHtml,
  renderAuditMarkdown,
  renderAuditPdf,
  renderLabelCsv,
  runAuditReport,
  scanVerdicts,
} from '../cli/audit-report';
import {
  bootstrapRate,
  cohensKappa,
  csvEscape,
  formatAgreementMarkdown,
  importReviewerLabels,
  parseCsv,
  parseReviewerLabel,
  type ScanVerdict,
} from '../cli/audit-labels';
import { renderCsv } from '../cli/export';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const demoPath = join(repoRoot, 'docs/demo/scan-result.json');
const samplePath = join(repoRoot, 'docs/demo/audit-scan.json');

function demoScan(): unknown {
  return JSON.parse(readFileSync(demoPath, 'utf8'));
}

function verdicts(map: Record<string, ScanVerdict>): Map<string, ScanVerdict> {
  return new Map(Object.entries(map));
}

function scopeSection(markdown: string): string {
  return markdown.slice(markdown.indexOf('## Scope'), markdown.indexOf('## Method'));
}

function pdfText(buf: Buffer): string {
  const s = buf.toString('latin1');
  const parts: string[] = [];
  const re = /<([0-9A-Fa-f\s]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const hex = m[1].replace(/\s+/g, '');
    if (hex.length % 2 !== 0) continue;
    parts.push(Buffer.from(hex, 'hex').toString('latin1'));
  }
  return parts.join('');
}

describe('audit report from the demo scan', () => {
  const model = buildAuditReport(demoScan());
  const markdown = renderAuditMarkdown(model);
  const html = renderAuditHtml(model);

  it('counts verdicts and separates provider failures from missing records', () => {
    expect(model.claims).toHaveLength(10);
    expect(model.byBucket).toEqual({
      supported: 0,
      contradicted: 0,
      mixed: 0,
      unsupported: 1,
      unchecked: 9,
    });
    expect(model.providerErrors).toBe(7);
    expect(model.otherUnchecked).toBe(2);
    expect(model.claims.find((c) => c.id === 's3')?.bucket).toBe('unsupported');
    expect(model.claims.filter((c) => c.uncheckedCode === 'no_record').map((c) => c.id)).toEqual(['s9', 's10']);
  });

  it('does not put the measurement model or commit on the scan', () => {
    expect(model.judgeModel).toBe('unknown');
    expect(model.engineCommit).toBe('unknown');
    expect(model.sourcePolicyMisses).toBe(0);
    expect(scopeSection(markdown)).not.toContain('gemini-2.5-flash');
    expect(scopeSection(markdown)).toContain('| Judge model recorded | unknown |');
    expect(html).toContain('<tr><th>Judge model recorded</th><td>unknown</td></tr>');
    for (const body of [markdown, html, limitationParagraphs(model).join('\n')]) {
      expect(body).not.toContain('ba11345');
      expect(body).toContain('The judge model recorded on this scan is unknown.');
      expect(body).toContain('The engine commit recorded on this scan is unknown.');
    }
  });

  it('does not copy provider error payloads or the scan compliance block into the report', () => {
    for (const body of [markdown, html]) {
      expect(body).not.toContain('RESOURCE_EXHAUSTED');
      expect(body).not.toContain('quotaValue');
      expect(body).not.toContain('ai.google.dev');
      expect(body).not.toContain('Recital 32');
      expect(body).not.toContain('Annex III');
      expect(body).not.toContain('voluntary codes of conduct');
    }
    expect(markdown).toContain('No structural analysis provided.');
    expect(markdown).toContain('rate-limited right now');
    expect(markdown).toContain('transient error');
    expect(markdown).toContain('No verification record for this claim.');
  });

  it('opens as an audit record, without a compliance frame in the header', () => {
    expect(markdown.startsWith('# AI output audit\n')).toBe(true);
    const intro = markdown.slice(0, markdown.indexOf('## Scope'));
    expect(intro).not.toMatch(/compliance|EU AI Act|certif|Reg\.\s*\(EU\)/i);
    expect(html).toContain('<h1>AI output audit</h1>');
    expect(html.slice(0, html.indexOf('<h2>Scope</h2>'))).not.toMatch(/compliance|EU AI Act|certif/i);
  });

  it('quotes the score-file accuracy and both interval ends, not a rounded-up figure', () => {
    const headline = ACCURACY_READINGS[0];
    for (const body of [markdown, html, limitationParagraphs(model).join('\n')]) {
      expect(body).toContain(headline.value);
      expect(body).toContain(headline.ciLow);
      expect(body).toContain(headline.ciHigh);
      expect(body).toContain(FAST_ARM.value);
      expect(body).toContain('rounds the point estimate and the lower bound up');
      expect(body).not.toContain('75.5%');
      expect(body).not.toContain('76%');
    }
  });

  it('hashes the scan input and does not invent a degraded flag', () => {
    const scan = demoScan() as { input: string };
    expect(model.inputSha256).toBe(createHash('sha256').update(scan.input, 'utf8').digest('hex'));
    expect(model.inputChars).toBe([...scan.input].length);
    expect(model.degradedFlag).toBeNull();
    expect(markdown).toContain('not recorded');
    expect(model.generatedAt).toBe('2026-06-03T00:02:45.974Z');
  });
});

describe('measured accuracy constants match the score files', () => {
  it('keeps every quoted reading equal to its score file', () => {
    for (const reading of ACCURACY_READINGS) {
      const score = JSON.parse(readFileSync(join(repoRoot, reading.scoreFile), 'utf8'));
      const metric = score.arms[reading.arm].balanced_accuracy;
      expect(JSON.stringify(metric.value)).toBe(reading.value);
      expect(JSON.stringify(metric.ci95[0])).toBe(reading.ciLow);
      expect(JSON.stringify(metric.ci95[1])).toBe(reading.ciHigh);
      expect(metric.ci95[0]).toBeLessThan(Number(reading.value));
      expect(metric.ci95[1]).toBeGreaterThan(Number(reading.value));
      expect(readFileSync(join(repoRoot, reading.writeup), 'utf8')).toContain(reading.commit);
    }
    const fast = JSON.parse(readFileSync(join(repoRoot, FAST_ARM.scoreFile), 'utf8'));
    const metric = fast.arms[FAST_ARM.arm].balanced_accuracy;
    expect(JSON.stringify(metric.value)).toBe(FAST_ARM.value);
    expect(JSON.stringify(metric.ci95[0])).toBe(FAST_ARM.ciLow);
    expect(JSON.stringify(metric.ci95[1])).toBe(FAST_ARM.ciHigh);
  });

  it('the published three-decimal form is higher on the point estimate and the lower bound', () => {
    const headline = ACCURACY_READINGS[0];
    expect(Number(headline.value)).toBeLessThan(0.755);
    expect(Number(headline.ciLow)).toBeLessThan(0.678);
    expect(Number(headline.ciHigh)).toBeGreaterThan(0.829);
    expect(Number(ACCURACY_READINGS[1].value)).toBeLessThan(0.802);
  });
});

describe('provenance on unsupported and contradicted claims', () => {
  const scan = {
    input: 'Acme shipped 12 widgets.',
    provider: 'Google Gemini',
    overallRisk: 'high',
    claims: [
      { id: 'c1', text: 'Acme shipped 12 widgets.', type: 'fact', importance: 5 },
      { id: 'c2', text: 'Acme was founded in 1999.', type: 'fact', importance: 4 },
      { id: 'c3', text: 'This report covers three models.', type: 'opinion', importance: 1 },
      { id: 'c4', text: 'Revenue grew, in a sense.', type: 'interpretation', importance: 2 },
      { id: 'c5', text: 'A cited page was fetched.', type: 'fact', importance: 3 },
    ],
    verifications: {
      c1: {
        claimId: 'c1',
        status: 'contradicted',
        explanation: 'The filing says 9.',
        sources: [
          {
            title: 'Filing',
            uri: 'https://example.com/filing',
            evidence: {
              status: 'ok',
              passage: 'shipped 9',
              fetchedAt: '2026-11-01T00:00:00.000Z',
              contentSha256: 'abc123',
            },
          },
          { title: 'Other', uri: 'https://example.com/other' },
        ],
        provenance: {
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          verifiedAt: '2026-11-01T00:00:01.000Z',
          retriever: 'parallel-search',
          retrievedAt: '2026-11-01T00:00:00.500Z',
          judgeFallback: true,
        },
      },
      c2: {
        claimId: 'c2',
        status: 'unverified',
        explanation: 'No source states the year.',
        sources: [],
        provenance: {
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          verifiedAt: '2026-11-01T00:00:02.000Z',
          retrievedAt: '2026-11-01T00:00:01.500Z',
        },
      },
      c3: {
        claimId: 'c3',
        status: 'unverified',
        explanation: NOT_CHECKABLE_EXPLANATION,
        notCheckable: true,
        sources: [{ title: 'Unrelated', uri: 'https://example.com/unrelated' }],
      },
      c4: {
        claimId: 'c4',
        status: 'mixed',
        explanation: 'Partly.',
        sources: [{ title: 'A', uri: 'https://example.com/a' }],
        provenance: { provider: 'gemini', model: 'gemini-2.5-flash', verifiedAt: '2026-11-01T00:00:03.000Z' },
      },
      c5: {
        claimId: 'c5',
        status: 'contradicted',
        explanation: 'The page says otherwise.',
        sources: [{
          title: 'Page',
          uri: 'https://example.com/page',
          evidence: {
            status: 'ok',
            passage: 'no',
            fetchedAt: '2026-11-02T03:00:00.000Z',
            contentSha256: 'def456',
          },
        }],
        provenance: { provider: 'gemini', model: 'gemini-2.5-flash', verifiedAt: '2026-11-02T03:00:01.000Z' },
      },
    },
  };

  const model = buildAuditReport(scan);
  const markdown = renderAuditMarkdown(model);

  it('puts contradicted and unsupported claims in one table, with recorded provenance only', () => {
    expect(model.byType.find((t) => t.type === 'fact')?.byBucket).toMatchObject({
      contradicted: 2,
      unsupported: 1,
    });
    expect(model.byType.find((t) => t.type === 'opinion')?.total).toBe(1);
    const section = markdown.slice(
      markdown.indexOf('## Unsupported and contradicted claims'),
      markdown.indexOf('## Mixed claims'),
    );
    expect(section).toContain('c1');
    expect(section).toContain('c2');
    expect(section).toContain('c5');
    expect(section).not.toContain('c3');
    expect(section).not.toContain('c4');
    expect(section).toContain('https://example.com/filing');
    expect(section).toContain('2026-11-01T00:00:00.500Z');
    expect(section).toContain('gemini-2.5-flash \\(fallback model\\)');
    expect(section).toContain('abc123');
    expect(section).toContain('1 source with no passage hash');
    expect(section).toContain('not recorded');
    expect(section).toContain('page fetched 2026-11-02T03:00:00.000Z');
    expect(section).toContain('def456');
  });

  it('lists a not-checkable claim with the unchecked claims, not as unsupported', () => {
    const unchecked = markdown.slice(markdown.indexOf('## Unchecked claims'), markdown.indexOf('## Limitations'));
    expect(model.claims.find((c) => c.id === 'c3')?.bucket).toBe('unchecked');
    expect(unchecked).toContain('c3');
    expect(unchecked).toContain(NOT_CHECKABLE_EXPLANATION);
    expect(unchecked).not.toContain('https://example.com/unrelated');
    const mixed = markdown.slice(markdown.indexOf('## Mixed claims'), markdown.indexOf('## Unchecked claims'));
    expect(mixed).toContain('c4');
    expect(mixed).toContain('https://example.com/a');
    expect(mixed).toContain('not recorded');
  });

  it('escapes a backslash before a pipe in a markdown cell', () => {
    const model = buildAuditReport({
      claims: [{ id: 'p', text: 'cost \\| 9', type: 'fact', importance: 1 }],
      verifications: {
        p: { claimId: 'p', status: 'contradicted', explanation: 'a\\|b', sources: [] },
      },
    });
    const section = renderAuditMarkdown(model);
    const row = section.split('\n').find((line) => line.startsWith('| p '));
    expect(row).toBeDefined();
    // "\|" in the claim is three backslashes and a pipe in the file: \\ then \|.
    expect(row).toContain('cost \\\\\\| 9');
    expect(row).toContain('a\\\\\\|b');
    expect(row).toContain('| contradicted |');
  });

  it('escapes claim text in html', () => {
    const nasty = buildAuditReport({
      claims: [{ id: 'x', text: '<script>alert(1)</script>', type: 'fact', importance: 1 }],
      verifications: { x: { claimId: 'x', status: 'contradicted', explanation: 'no & <yes>', sources: [] } },
    });
    const page = renderAuditHtml(nasty);
    expect(page).not.toContain('<script>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('no &amp; &lt;yes&gt;');
  });

  it('exports a reviewer CSV whose provenance cells are empty when the scan recorded none', () => {
    const csv = renderLabelCsv(model);
    const rows = parseCsv(csv);
    expect(rows[0]).toContain('reviewer_label');
    expect(rows[0]).toContain('passage_sha256');
    const c2 = rows.find((r) => r[0] === 'c2');
    expect(c2?.[4]).toBe('unverified');
    expect(c2?.[5]).toBe('unsupported');
    expect(c2?.[13]).toBe('');
    const c1 = rows.find((r) => r[0] === 'c1');
    expect(c1?.[13]).toBe('abc123');
    expect(c1?.[11]).toContain('fallback model');
    const c3 = rows.find((r) => r[0] === 'c3');
    expect(c3?.[5]).toBe('unchecked');
    expect(c3?.[8]).toBe('');
    expect(c3?.[15]).toBe('');
  });
});

describe('reviewer CSV import', () => {
  it('parses quotes, commas and newlines', () => {
    expect(parseCsv('a,"b,c","d""e"\r\n"f\ng",h\n')).toEqual([
      ['a', 'b,c', 'd"e'],
      ['f\ng', 'h'],
    ]);
  });

  it('reads the reviewer words the export asks for', () => {
    expect(parseReviewerLabel(' Refuted ')).toBe('contradicted');
    expect(parseReviewerLabel('unsupported')).toBe('unverified');
    expect(parseReviewerLabel('skip')).toBe('skip');
    expect(parseReviewerLabel('')).toBe('blank');
    expect(parseReviewerLabel('maybe')).toBe('invalid');
  });

  it('pins the bootstrap interval for a fixed error pattern', () => {
    const once = bootstrapRate([true, false, false, false, true]);
    const twice = bootstrapRate([true, false, false, false, true]);
    expect(once.rate).toBe(0.4);
    expect(once.ci95.map(String)).toEqual(['0', '0.8']);
    expect(twice.ci95).toEqual(once.ci95);
    expect(bootstrapRate([false, false, false]).ci95).toEqual([0, 0]);
    expect(bootstrapRate([true, true]).ci95).toEqual([1, 1]);
    expect(once.ci95[0]).toBeLessThanOrEqual(once.rate);
    expect(once.ci95[1]).toBeGreaterThanOrEqual(once.rate);
  });

  it('computes Cohen\'s kappa, including the undefined case', () => {
    expect(cohensKappa(
      ['supported', 'supported', 'supported', 'contradicted'],
      ['supported', 'supported', 'contradicted', 'contradicted'],
    )).toBeCloseTo(0.5, 10);
    expect(cohensKappa(['supported', 'supported'], ['supported', 'supported'])).toBeNull();
  });

  it('scores exact-match error against the majority and reports reviewer agreement', () => {
    const csv = [
      'claim_id,engine_status,engine_bucket,reviewer_id,reviewer_label',
      'c1,supported,supported,alice,supported',
      'c1,supported,supported,bob,supported',
      'c2,supported,supported,alice,contradicted',
      'c2,supported,supported,bob,contradicted',
      'c3,supported,supported,alice,supported',
      'c3,supported,supported,bob,contradicted',
      'c4,unverified,unsupported,alice,skip',
      'c5,,unchecked,alice,contradicted',
      'c6,supported,supported,alice,maybe',
    ].join('\n');
    const result = importReviewerLabels(csv, verdicts({
      c1: 'supported', c2: 'supported', c3: 'supported', c4: 'unverified', c5: 'unchecked', c6: 'supported',
    }));
    expect(result.scored).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.errorRate).toBe(0.5);
    expect(result.excludedNoMajority).toBe(1);
    expect(result.noMajorityClaimIds).toEqual(['c3']);
    expect(result.excludedNoLabel).toBe(1);
    expect(result.excludedUnchecked).toBe(1);
    expect(result.uncheckedButLabelled).toBe(1);
    expect(result.excludedUnknownLabel).toBe(1);
    expect(result.unknownLabelClaimIds).toEqual(['c6']);
    expect(result.scanClaims).toBe(6);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].n).toBe(3);
    expect(result.pairs[0].agreements).toBe(2);
    expect(result.pairs[0].cohensKappa).toBeCloseTo(0.4, 10);
    expect(result.confusion.supported.contradicted).toBe(1);
    expect(result.confusion.supported.supported).toBe(1);
    const md = formatAgreementMarkdown(result);
    expect(md).toContain('Cohen\'s kappa');
    expect(md).toContain('not balanced accuracy');
    expect(result.errorRateCi95?.[0]).toBeLessThanOrEqual(0.5);
    expect(result.errorRateCi95?.[1]).toBeGreaterThanOrEqual(0.5);
  });

  it('does not invent a zero error rate when nothing was scored', () => {
    const result = importReviewerLabels('claim_id,engine_status,reviewer_label\nc1,,\n', verdicts({ c1: 'supported' }));
    expect(result.scored).toBe(0);
    expect(result.errorRate).toBeNull();
    expect(result.errorRateCi95).toBeNull();
    const md = formatAgreementMarkdown(result);
    expect(md).toContain('was not computed');
    expect(md).not.toContain('Error rate: 0');
  });

  it('round-trips a claim whose text contains a comma, a quote and a newline', () => {
    const model = buildAuditReport({
      claims: [{ id: 'q', text: 'She said "no",\nthen left.', type: 'fact', importance: 2 }],
      verifications: {
        q: { claimId: 'q', status: 'supported', explanation: 'A source says so.', sources: [] },
      },
    });
    const csv = renderLabelCsv(model);
    expect(parseCsv(csv)[1][1]).toBe('She said "no",\nthen left.');
    expect(csv).toContain('"She said ""no"",');
  });

  it('excludes a claim when one reviewer gave it two labelled rows, and leaves it out of reviewer agreement', () => {
    const csv = [
      'claim_id,engine_status,reviewer_id,reviewer_label',
      'c1,supported,alice,contradicted',
      'c1,supported,alice,supported',
      'c1,,bob,supported',
      'c2,supported,alice,supported',
      'c2,supported,bob,supported',
    ].join('\n');
    const result = importReviewerLabels(csv, verdicts({ c1: 'supported', c2: 'supported' }));
    expect(result.scored).toBe(1);
    expect(result.excludedConflict).toBe(1);
    expect(result.conflictClaimIds).toEqual(['c1']);
    expect(result.scored).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.pairs[0].n).toBe(1);
    expect(formatAgreementMarkdown(result)).toContain(
      'Excluded, conflict (one reviewer gave the claim more than one labelled row): 1. Claim ids: c1',
    );
  });

  it('a later blank row does not hide an earlier label from the same reviewer', () => {
    const csv = [
      'claim_id,engine_status,reviewer_id,reviewer_label',
      'c1,supported,alice,contradicted',
      'c1,supported,alice,',
    ].join('\n');
    const result = importReviewerLabels(csv, verdicts({ c1: 'supported' }));
    expect(result.scored).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.excludedNoLabel).toBe(0);
    expect(result.blankDuplicateRows).toBe(1);
    expect(formatAgreementMarkdown(result)).toContain(
      'Extra rows with a blank label for a claim and reviewer that already had a row, ignored: 1',
    );
  });

  it('refuses a CSV with no reviewer column', () => {
    expect(() => importReviewerLabels('claim_id,engine_status\nc1,supported\n', verdicts({ c1: 'supported' }))).toThrow(/reviewer_label/);
  });

  it('excludes a claim with an unknown label even when another reviewer agreed with the scan', () => {
    const csv = [
      'claim_id,engine_status,reviewer_id,reviewer_label',
      'c1,supported,alice,maybe',
      'c1,supported,bob,supported',
    ].join('\n');
    const result = importReviewerLabels(csv, verdicts({ c1: 'supported' }));
    expect(result.scored).toBe(0);
    expect(result.agreements).toBe(0);
    expect(result.excludedUnknownLabel).toBe(1);
    expect(result.unknownLabelClaimIds).toEqual(['c1']);
    expect(result.errorRate).toBeNull();
    expect(formatAgreementMarkdown(result)).toContain('Excluded, unknown label: 1. Claim ids: c1');
  });

  it('counts and reports a labelled row with an empty claim id', () => {
    const csv = [
      'claim_id,engine_status,reviewer_id,reviewer_label',
      ',supported,alice,contradicted',
      'c1,supported,alice,supported',
    ].join('\n');
    const result = importReviewerLabels(csv, verdicts({ c1: 'supported' }));
    expect(result.rowsNoClaimId).toBe(1);
    expect(result.csvRows).toBe(2);
    expect(result.scored).toBe(1);
    expect(formatAgreementMarkdown(result)).toContain('Rows with no claim id: 1');
  });

  it('scores against the scan verdict, never the CSV engine columns, and lists ids not in the scan', () => {
    const csv = [
      'claim_id,engine_status,engine_bucket,reviewer_id,reviewer_label',
      'a,supported,supported,alice,supported',
      'zz,supported,supported,alice,supported',
      'zz,supported,supported,bob,supported',
      'yy,contradicted,contradicted,alice,supported',
    ].join('\n');
    const result = importReviewerLabels(csv, verdicts({ a: 'contradicted', b: 'supported' }));
    expect(result.scored).toBe(1);
    expect(result.scanClaims).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.confusion.contradicted.supported).toBe(1);
    expect(result.engineColumnMismatches).toBe(1);
    expect(result.rowsNotInScan).toBe(3);
    expect(result.notInScanClaimIds).toEqual(['yy', 'zz']);
    expect(result.excludedNotInCsv).toBe(1);
    expect(result.reviewers).toEqual(['alice']);
    const md = formatAgreementMarkdown(result);
    expect(md).toContain("Rows whose claim id is not in the scan: 3, 2 distinct claim ids: yy, zz");
    expect(md).toContain('Excluded, no row in the CSV: 1');
    expect(md).toContain('Scored claims: 1 of 2');
  });

  it('accounts for every scan claim exactly once', () => {
    const csv = [
      'claim_id,reviewer_id,reviewer_label',
      'ok,alice,supported',
      'unc,alice,supported',
      'dup,alice,supported',
      'dup,alice,contradicted',
      'unk,alice,maybe',
      'none,alice,skip',
      'tie,alice,supported',
      'tie,bob,contradicted',
      ',alice,supported',
      'ghost,alice,supported',
    ].join('\n');
    const result = importReviewerLabels(csv, verdicts({
      ok: 'supported', unc: 'unchecked', dup: 'supported', unk: 'supported', none: 'supported', tie: 'supported', absent: 'mixed',
    }));
    const excluded = result.excludedUnchecked + result.excludedNotInCsv + result.excludedConflict +
      result.excludedUnknownLabel + result.excludedNoLabel + result.excludedNoMajority;
    expect(result.scanClaims).toBe(7);
    expect(result.scored + excluded).toBe(result.scanClaims);
    expect([result.scored, result.excludedUnchecked, result.excludedNotInCsv, result.excludedConflict,
      result.excludedUnknownLabel, result.excludedNoLabel, result.excludedNoMajority]).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(result.rowsNoClaimId).toBe(1);
    expect(result.rowsNotInScan).toBe(1);
  });

  it('escapes reviewer ids in the agreement markdown', () => {
    const csv = [
      'claim_id,engine_status,reviewer_id,reviewer_label',
      'c1,supported,<img src=x onerror=alert(1)>,supported',
      'c1,supported,[a](javascript:alert(1)),supported',
    ].join('\n');
    const md = formatAgreementMarkdown(importReviewerLabels(csv, verdicts({ c1: 'supported' })));
    expect(md).not.toContain('<img');
    expect(md).not.toContain('](javascript:');
    expect(md).toContain('&lt;img src=x onerror=alert\\(1\\)&gt;');
    expect(md).toContain('\\[a\\]\\(javascript:alert\\(1\\)\\)');
  });
});

describe('synthetic example sample', () => {
  const scan = JSON.parse(readFileSync(samplePath, 'utf8'));
  const model = buildAuditReport(scan);
  const markdown = renderAuditMarkdown(model);
  const html = renderAuditHtml(model);

  it('populates supported, contradicted and unverified rows and says the file is an example', () => {
    expect(model.syntheticExample).toBe(true);
    expect(model.byBucket).toEqual({
      supported: 1,
      contradicted: 1,
      mixed: 1,
      unsupported: 1,
      unchecked: 1,
    });
    expect(model.judgeModel).toBe('example-judge');
    expect(model.engineCommit).toBe('unknown');
    expect(model.sourcePolicyMisses).toBe(1);
    expect(model.providerErrors).toBe(0);
    expect(markdown).toContain('Synthetic example data.');
    expect(markdown).toContain('https://example.test/northwind/payments');
    expect(markdown).toContain('Unchecked: no allowed source found');
    expect(scopeSection(markdown)).not.toContain('gemini-2.5-flash');
    expect(markdown).not.toContain('ba11345');
    const findings = markdown.slice(
      markdown.indexOf('## Unsupported and contradicted claims'),
      markdown.indexOf('## Mixed claims'),
    );
    expect(findings).toContain('n2');
    expect(findings).toContain('n3');
    expect(findings).not.toContain('None. The scan recorded no contradicted');
  });

  it('matches the committed markdown, html and pdf samples', async () => {
    expect(markdown).toBe(readFileSync(join(repoRoot, 'docs/demo/audit-report.md'), 'utf8'));
    expect(html).toBe(readFileSync(join(repoRoot, 'docs/demo/audit-report.html'), 'utf8'));
    const pdf = await renderAuditPdf(model);
    const again = await renderAuditPdf(model);
    expect(pdf.equals(again)).toBe(true);
    expect(pdf.equals(readFileSync(join(repoRoot, 'docs/demo/audit-report.pdf')))).toBe(true);
    expect(pdfText(pdf)).toContain('Synthetic example data.');
    expect(pdfText(pdf)).toContain('example-judge');
  });
});

describe('judge model and engine commit come from the scan', () => {
  it('says unknown when the scan recorded neither', () => {
    const model = buildAuditReport({ input: 'x', claims: [], verifications: {} });
    expect(model.judgeModel).toBe('unknown');
    expect(model.engineCommit).toBe('unknown');
    const text = renderAuditMarkdown(model);
    expect(text).toContain('The judge model recorded on this scan is unknown.');
    expect(text).toContain('The engine commit recorded on this scan is unknown.');
    expect(scopeSection(text)).not.toContain('gemini-2.5-flash');
    expect(text).not.toContain('ba11345');
  });

  it('reads a verdict provenance model and a scan commit, and a config value when provenance is absent', () => {
    const fromVerdict = buildAuditReport({
      engineCommit: 'cafebabe',
      claims: [{ id: 'a', text: 't', type: 'fact', importance: 1 }],
      verifications: {
        a: {
          claimId: 'a',
          status: 'supported',
          explanation: 'y',
          sources: [{ uri: 'https://example.test/a', title: 'A' }],
          provenance: { provider: 'example', model: 'example-judge', verifiedAt: '2026-11-17T00:00:00.000Z' },
        },
      },
    });
    expect(fromVerdict.judgeModel).toBe('example-judge');
    expect(fromVerdict.engineCommit).toBe('cafebabe');

    const fromConfig = buildAuditReport({
      config: { judgeModel: 'from-config', engineCommit: 'cfg123' },
      claims: [],
      verifications: {},
    });
    expect(fromConfig.judgeModel).toBe('from-config');
    expect(fromConfig.engineCommit).toBe('cfg123');
  });
});

describe('source policy misses are not provider errors', () => {
  function one(verification: Record<string, unknown>) {
    return buildAuditReport({
      claims: [{ id: 'p', text: 'A fee schedule line.', type: 'fact', importance: 1 }],
      verifications: { p: verification },
    });
  }

  it('labels a distinct reason, a provenance flag, and the allowlist sentence', () => {
    const reason = one({
      claimId: 'p', status: 'unverified', apiError: true, apiErrorReason: 'source_policy_no_match',
      explanation: 'not checked', sources: [],
    });
    expect(reason.claims[0].explanation).toBe('Unchecked: no allowed source found');
    expect(reason.providerErrors).toBe(0);
    expect(reason.sourcePolicyMisses).toBe(1);

    const flag = one({
      claimId: 'p', status: 'unverified', apiError: true, apiErrorReason: 'provider_error',
      explanation: 'not checked', sources: [],
      provenance: { sourcePolicyNoMatch: true },
    });
    expect(flag.claims[0].explanation).toBe('Unchecked: no allowed source found');
    expect(flag.providerErrors).toBe(0);

    const sentence = one({
      claimId: 'p', status: 'unverified', apiError: true, apiErrorReason: 'provider_error',
      explanation: 'No source on the configured source-policy allowlist was found, so this claim was not checked.',
      sources: [],
    });
    expect(sentence.claims[0].bucket).toBe('unchecked');
    expect(sentence.claims[0].explanation).toBe('Unchecked: no allowed source found');
    expect(sentence.providerErrors).toBe(0);
    expect(renderAuditMarkdown(sentence)).toContain('Unchecked: no allowed source found');
    expect(renderAuditMarkdown(sentence)).not.toContain('provider error. An unchecked');
  });

  it('keeps a provider error a provider error when no policy field or sentence is present', () => {
    const plain = one({
      claimId: 'p', status: 'unverified', apiError: true, apiErrorReason: 'provider_error',
      explanation: 'The provider failed.', sources: [],
    });
    expect(plain.claims[0].uncheckedCode).toBe('provider_error');
    expect(plain.providerErrors).toBe(1);
    expect(plain.sourcePolicyMisses).toBe(0);
    expect(plain.claims[0].explanation).not.toContain('no allowed source');
  });
});

describe('spreadsheet formula cells', () => {
  it('prefixes = + - @ tab and CR with one quote, and a round-trip restores the text', () => {
    for (const cell of ['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd', '=1,2', '=say "hi"']) {
      const escaped = csvEscape(cell);
      expect(escaped.startsWith("'") || escaped.startsWith("\"'")).toBe(true);
      expect(parseCsv(escaped + '\n')[0][0]).toBe(cell);
    }
    expect(csvEscape('supported')).toBe('supported');
    expect(csvEscape('She said "no"')).toBe('"She said ""no"""');
  });

  it('neutralizes a claim that starts with = in the reviewer CSV and the history CSV', () => {
    const model = buildAuditReport({
      claims: [{ id: 'f', text: '=HYPERLINK("https://example.test")', type: 'fact', importance: 1 }],
      verifications: {
        f: { claimId: 'f', status: 'contradicted', explanation: '+cmd', sources: [{ title: '@title', uri: 'https://example.test/x' }] },
      },
    });
    const labels = renderLabelCsv(model);
    expect(labels).toContain("'=HYPERLINK");
    expect(labels).toContain("'+cmd");
    expect(labels).toContain("'@title");
    expect(parseCsv(labels)[1][1]).toBe('=HYPERLINK("https://example.test")');

    const history = renderCsv([{
      timestamp: '2026-11-17T00:00:00.000Z',
      file: 'note.txt',
      provider: 'example',
      overallRisk: 'low',
      findingCount: 0,
      claimCount: 1,
      verificationCount: 1,
      ruleFindings: [],
      scanResult: {
        input: '=1',
        provider: 'example',
        claims: [{ id: 'f', text: '=HYPERLINK("https://example.test")', type: 'fact', importance: 1 }],
        verifications: { f: { claimId: 'f', status: 'contradicted', explanation: '-2+2', sources: [] } },
        overallRisk: 'low',
        complianceReport: { generatedAt: '2026-11-17T00:00:00.000Z' },
        ruleFindings: [],
      },
    } as never]);
    expect(history).toContain("'=HYPERLINK");
    expect(history).toContain("'-2+2");
  });
});

describe('audit-report command', () => {
  it('is named in the help text', async () => {
    const { output } = await main(['help']);
    expect(output).toContain('faultline audit-report --scan');
    expect(output).toContain('--labels-out');
    expect(output).toContain('--import-labels');
  });

  it('writes the demo markdown and a reviewer CSV', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'faultline-audit-'));
    const out = join(dir, 'report.md');
    const csv = join(dir, 'claims.csv');
    const { exitCode, output } = await runAuditReport({ scan: demoPath, out, 'labels-out': csv });
    expect(exitCode).toBe(0);
    expect(output).toContain('Unsupported: 1');
    expect(output).toContain('Unchecked: 9');
    expect(readFileSync(out, 'utf8')).toContain('The judge model recorded on this scan is unknown.');
    expect(readFileSync(csv, 'utf8').split('\n')[0]).toContain('reviewer_label');
  });

  it('rejects a missing scan, a bad extension and an import without --scan', async () => {
    expect((await runAuditReport({})).exitCode).toBe(1);
    expect((await runAuditReport({ scan: demoPath })).output).toMatch(/--out/);
    expect((await runAuditReport({ scan: join(repoRoot, 'no-such.json'), out: 'r.md' })).output).toMatch(/not found/);
    const dir = mkdtempSync(join(tmpdir(), 'faultline-audit-'));
    const bad = join(dir, 'notes.txt');
    writeFileSync(bad, 'not json');
    expect((await runAuditReport({ scan: bad, out: join(dir, 'r.md') })).output).toMatch(/could not parse/);
    expect((await runAuditReport({ scan: demoPath, out: join(dir, 'r.csv') })).output).toMatch(/--labels-out/);
    const noScan = await runAuditReport({ 'import-labels': bad });
    expect(noScan.exitCode).toBe(1);
    expect(noScan.output).toMatch(/--import-labels needs --scan/);
  });

  it('imports labels through the command and writes JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'faultline-audit-'));
    const csvPath = join(dir, 'labels.csv');
    const jsonPath = join(dir, 'agreement.json');
    const scanPath = join(dir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify({
      claims: [
        { id: 'a', text: 'A.', type: 'fact', importance: 1 },
        { id: 'b', text: 'B.', type: 'fact', importance: 1 },
        { id: 'c', text: 'C.', type: 'fact', importance: 1 },
      ],
      verifications: {
        a: { claimId: 'a', status: 'supported', explanation: 'y', sources: [] },
        b: { claimId: 'b', status: 'supported', explanation: 'y', sources: [] },
      },
    }));
    writeFileSync(csvPath, [
      'claim_id,engine_status,engine_bucket,reviewer_label',
      'a,supported,supported,supported',
      'b,supported,supported,contradicted',
      'c,,unchecked,supported',
    ].join('\n'));
    const { exitCode, output } = await main(['audit-report', '--scan', scanPath, '--import-labels', csvPath, '--out', jsonPath]);
    expect(exitCode).toBe(0);
    expect(output).toContain(jsonPath);
    const body = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(body.scored).toBe(2);
    expect(body.errors).toBe(1);
    expect(body.errorRate).toBe(0.5);
    expect(body.excludedUnchecked).toBe(1);
    expect(body.method).toContain('Not the published balanced accuracy');
    expect(body.scanClaims).toBe(3);
    expect(output).toContain('Scored 2 of 3 claims in the scan.');
    expect(body.errorRateCi95[0]).toBeLessThanOrEqual(0.5);
    expect(body.errorRateCi95[1]).toBeGreaterThanOrEqual(0.5);
  });

  it('prints the agreement on stdout when --out is omitted, and refuses a zero rate it did not measure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'faultline-audit-'));
    const csvPath = join(dir, 'blank.csv');
    const scanPath = join(dir, 'scan.json');
    writeFileSync(scanPath, JSON.stringify({ claims: [{ id: 'z', text: 'Z.', type: 'fact', importance: 1 }], verifications: {} }));
    writeFileSync(csvPath, 'claim_id,engine_bucket,reviewer_label\nz,unchecked,\n');
    const { exitCode, output } = await main(['audit-report', '--scan', scanPath, '--import-labels', csvPath]);
    expect(exitCode).toBe(0);
    expect(output).toContain('was not computed');
    expect(output).not.toMatch(/Error rate: 0/);
  });
});

describe('untrusted scan text in markdown', () => {
  it('escapes raw HTML and link, emphasis and code syntax in table cells', () => {
    const model = buildAuditReport({
      provider: '<b>prov</b>',
      claims: [{ id: 'm', text: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) *b* _i_ `c` & ok', type: 'fact', importance: 1 }],
      verifications: {
        m: {
          claimId: 'm',
          status: 'contradicted',
          explanation: '<script>x</script>',
          sources: [{ title: '[t](javascript:alert(2))', uri: 'https://example.test/a_b' }],
        },
      },
    });
    const md = renderAuditMarkdown(model);
    const row = md.split('\n').find((line) => line.startsWith('| m '));
    expect(row).toBeDefined();
    expect(md).not.toContain('<img');
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('<b>');
    expect(md).not.toContain('](javascript:');
    expect(row).toContain('&lt;img src=x onerror=alert\\(1\\)&gt;');
    expect(row).toContain('\\[x\\]\\(javascript:alert\\(1\\)\\)');
    expect(row).toContain('\\*b\\* \\_i\\_ \\`c\\` &amp; ok');
    expect(row).toContain('\\[t\\]\\(javascript:alert\\(2\\)\\)');
    expect(row).toContain('https://example.test/a\\_b');
    expect(md).toContain('| Provider recorded | &lt;b&gt;prov&lt;/b&gt; |');
  });

  it('escapes the recorded judge model and commit in the limitations paragraph', () => {
    const md = renderAuditMarkdown(buildAuditReport({
      judgeModel: '<img src=x>',
      engineCommit: '[c](javascript:1)',
      claims: [],
      verifications: {},
    }));
    const limits = md.slice(md.indexOf('## Limitations'));
    expect(limits).toContain('The judge model recorded on this scan is &lt;img src=x&gt;.');
    expect(limits).toContain('The engine commit recorded on this scan is \\[c\\]\\(javascript:1\\).');
  });

  it('quotes the input in a tilde fence longer than any tilde run in it, with the text unchanged', () => {
    const input = 'first\n~~~~\n<b>not html</b>\n~~~~~~\n```\nlast';
    const md = renderAuditMarkdown(buildAuditReport({ input, claims: [], verifications: {} }));
    expect(md).toContain('\n~~~~~~~\n' + input + '\n~~~~~~~\n');
    const plain = renderAuditMarkdown(buildAuditReport({ input: 'no tildes', claims: [], verifications: {} }));
    expect(plain).toContain('\n~~~~\nno tildes\n~~~~\n');
  });
});

describe('a claim with no id', () => {
  it('is unchecked, and its label neither takes nor hides a real verification', () => {
    const model = buildAuditReport({
      claims: [
        { text: 'A claim the scan saved without an id.', type: 'fact', importance: 1 },
        { id: 'c2', text: 'A claim with an id.', type: 'fact', importance: 1 },
      ],
      verifications: {
        'missing-id-1': { claimId: 'missing-id-1', status: 'contradicted', explanation: 'A real record.', sources: [] },
        c2: { claimId: 'c2', status: 'supported', explanation: 'y', sources: [] },
      },
    });
    expect(model.claims).toHaveLength(3);
    const noId = model.claims[0];
    expect(noId.text).toBe('A claim the scan saved without an id.');
    expect(noId.bucket).toBe('unchecked');
    expect(noId.status).toBeNull();
    expect(noId.id).not.toBe('missing-id-1');
    expect(noId.explanation).toContain('no id in the scan file');
    const real = model.claims.find((c) => c.id === 'missing-id-1');
    expect(real?.bucket).toBe('contradicted');
    expect(real?.text).toBe('not recorded');
    expect(new Set(model.claims.map((c) => c.id)).size).toBe(3);
    expect(model.byBucket.contradicted).toBe(1);
    expect(model.byBucket.unchecked).toBe(1);
    expect(scanVerdicts(model).get(noId.id)).toBe('unchecked');
  });
});

describe('the headline accuracy states its judge model and date', () => {
  const model = buildAuditReport({ claims: [], verifications: {} });

  it('names the measurement judge model and date, and says the production judge changed since', async () => {
    const pdf = pdfText(await renderAuditPdf(model));
    for (const body of [renderAuditMarkdown(model), renderAuditHtml(model), limitationParagraphs(model).join('\n'), pdf]) {
      expect(body).toContain(
        `It was measured on 2026-11-06 with the judge model gemini-2.5-flash (${ACCURACY_READINGS[0].writeup}).`,
      );
      expect(body).toContain(
        'The production judge model changed on 2026-11-14, to gemini-3.1-pro-preview. This hosted figure has not been re-measured since that change.',
      );
      expect(body).toContain(ACCURACY_READINGS[0].value);
    }
    expect(scopeSection(renderAuditMarkdown(model))).toContain('| Judge model recorded | unknown |');
  });

  it('takes the judge model and date from the headline write-up and run file', () => {
    expect(HEADLINE_MEASUREMENT.judgeModel).toBe('gemini-2.5-flash');
    expect(PRODUCTION_JUDGE_CHANGE.on).toBe('2026-11-14');
    const writeup = readFileSync(join(repoRoot, ACCURACY_READINGS[0].writeup), 'utf8');
    expect(writeup).toContain(HEADLINE_MEASUREMENT.writeupJudgeWords);
    const score = JSON.parse(readFileSync(join(repoRoot, ACCURACY_READINGS[0].scoreFile), 'utf8'));
    const rows = readFileSync(join(repoRoot, score.arms.parallel.run), 'utf8').trim().split('\n');
    expect(rows.length).toBeGreaterThan(0);
    const days = new Set(rows.map((line) => String(JSON.parse(line).ts).slice(0, 10)));
    expect([...days]).toEqual([HEADLINE_MEASUREMENT.measuredOn]);
  });
});

describe('audit-report --import-labels needs the scan', () => {
  it('scores imported labels against the scan file and reports invented ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'faultline-audit-'));
    const scanPath = join(dir, 'scan.json');
    const csvPath = join(dir, 'labels.csv');
    writeFileSync(scanPath, JSON.stringify({
      claims: [{ id: 'a', text: 'A.', type: 'fact', importance: 1 }],
      verifications: { a: { claimId: 'a', status: 'contradicted', explanation: 'n', sources: [] } },
    }));
    writeFileSync(csvPath, [
      'claim_id,engine_status,engine_bucket,reviewer_label',
      'a,supported,supported,supported',
      'invented,supported,supported,contradicted',
    ].join('\n'));
    const { exitCode, output } = await runAuditReport({ scan: scanPath, 'import-labels': csvPath });
    expect(exitCode).toBe(0);
    expect(output).toContain('Scored claims: 1 of 1');
    expect(output).toContain('Errors: 1');
    expect(output).toContain('Rows whose claim id is not in the scan: 1, 1 distinct claim ids: invented');
    expect(output).toContain("Rows whose engine columns differ from the scan (the scan's verdict was used): 1");
    expect(output).toContain('Error rate: 1/1 = 1');
  });
});
