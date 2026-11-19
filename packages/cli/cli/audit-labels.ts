/**
 * Reviewer-label CSV for an AI output audit, and the importer that scores it.
 *
 * The export is one row per claim, with empty reviewer columns. The importer
 * reads those columns back and reports two different things:
 *
 *   - reviewer agreement: how often two reviewers gave the same label
 *     (percent agreement and Cohen's kappa), when more than one reviewer
 *     labelled the file;
 *   - the measured error rate: how often the scan's verdict differs from the
 *     reviewer label, with a bootstrap interval.
 *
 * The error rate is an exact match on four words (supported, contradicted,
 * mixed, unverified). It is not the published balanced accuracy, and its
 * interval is not the numpy bootstrap that produced that figure.
 */

export const BOOTSTRAP_RESAMPLES = 2000;
export const BOOTSTRAP_SEED = 20260929;

export const LABEL_CSV_COLUMNS = [
  'claim_id',
  'claim_text',
  'claim_type',
  'importance',
  'engine_status',
  'engine_bucket',
  'unchecked_reason',
  'explanation',
  'source_uris',
  'source_titles',
  'retrieved_at',
  'model',
  'provider',
  'passage_sha256',
  'reviewer_id',
  'reviewer_label',
  'reviewer_notes',
] as const;

export type EngineWord = 'supported' | 'contradicted' | 'mixed' | 'unverified';

const ENGINE_WORDS: readonly EngineWord[] = ['supported', 'contradicted', 'mixed', 'unverified'];

export class AuditLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditLabelError';
  }
}

/** mulberry32. The published accuracy interval uses numpy's generator; this one does not. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Linear percentile, the numpy default: index (p/100)*(n-1), interpolated.
 * `sorted` must already be sorted ascending.
 */
export function percentileLinear(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new AuditLabelError('No bootstrap values to summarise.');
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

export interface BootstrapInterval {
  rate: number;
  ci95: [number, number];
  resamples: number;
  seed: number;
}

/**
 * Bootstrap a 0/1 error indicator. Items stay in the order given (the caller
 * sorts claims by id). Each resample draws n indexes with replacement.
 */
export function bootstrapRate(
  errors: readonly boolean[],
  seed = BOOTSTRAP_SEED,
  resamples = BOOTSTRAP_RESAMPLES,
): BootstrapInterval {
  if (errors.length === 0) throw new AuditLabelError('No scored claims to bootstrap.');
  const flags = errors.map((e) => (e ? 1 : 0));
  const n = flags.length;
  const rate = flags.reduce((a, b) => a + b, 0) / n;
  const rng = mulberry32(seed);
  const rates = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += flags[Math.floor(rng() * n)];
    rates[r] = sum / n;
  }
  rates.sort((a, b) => a - b);
  return {
    rate,
    ci95: [percentileLinear(rates, 2.5), percentileLinear(rates, 97.5)],
    resamples,
    seed,
  };
}

/**
 * Cohen's kappa for two equal-length label lists. Null when there is nothing
 * to score or when chance agreement is 1 (kappa is then undefined).
 */
export function cohensKappa(a: readonly string[], b: readonly string[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  const n = a.length;
  const labels = new Set<string>();
  const ca: Record<string, number> = {};
  const cb: Record<string, number> = {};
  let agree = 0;
  for (let i = 0; i < n; i++) {
    labels.add(a[i]);
    labels.add(b[i]);
    ca[a[i]] = (ca[a[i]] ?? 0) + 1;
    cb[b[i]] = (cb[b[i]] ?? 0) + 1;
    if (a[i] === b[i]) agree++;
  }
  let pe = 0;
  for (const lab of labels) pe += ((ca[lab] ?? 0) / n) * ((cb[lab] ?? 0) / n);
  if (pe === 1) return null;
  return (agree / n - pe) / (1 - pe);
}

/** Characters a spreadsheet treats as the start of a formula (OWASP CSV injection). */
const SPREADSHEET_FORMULA_START = '=+-@\t\r';

function spreadsheetPrefix(s: string): string {
  if (s.length > 0 && SPREADSHEET_FORMULA_START.includes(s[0])) return "'" + s;
  return s;
}

/** Drop the one quote this exporter added so a round-trip keeps the original text. */
function undoSpreadsheetPrefix(s: string): string {
  if (s.length > 1 && s[0] === "'" && SPREADSHEET_FORMULA_START.includes(s[1])) return s.slice(1);
  return s;
}

export function csvEscape(val: unknown): string {
  const raw = val === null || val === undefined ? '' : String(val);
  const s = spreadsheetPrefix(raw);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function renderCsvRow(fields: readonly unknown[]): string {
  return fields.map(csvEscape).join(',');
}

/** RFC 4180 reader. A trailing newline does not invent an empty row. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(undoSpreadsheetPrefix(field));
      field = '';
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(undoSpreadsheetPrefix(field));
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(undoSpreadsheetPrefix(field));
    rows.push(row);
  }
  // A blank line is dropped. A row of delimiters with every cell empty (",,,,")
  // is kept, so the import counts it as a row with no claim id.
  return rows.filter((r) => r.length > 1 || r.some((cell) => cell.length > 0));
}

export type ParsedReviewerLabel = EngineWord | 'skip' | 'blank' | 'invalid';

/** Map a cell onto the four verdict words. "unsupported" is unverified. */
export function parseReviewerLabel(raw: string): ParsedReviewerLabel {
  const s = raw.trim().toLowerCase();
  if (!s) return 'blank';
  if (s === 'skip' || s === 'abstain' || s === 'n/a' || s === 'na') return 'skip';
  if (s === 'supported' || s === 'verified' || s === 'true') return 'supported';
  if (s === 'contradicted' || s === 'refuted' || s === 'false') return 'contradicted';
  if (s === 'mixed') return 'mixed';
  if (s === 'unverified' || s === 'unsupported') return 'unverified';
  return 'invalid';
}

export function engineWordFromCells(status: string, bucket: string): EngineWord | 'unchecked' | 'unknown' {
  const st = status.trim().toLowerCase();
  if ((ENGINE_WORDS as readonly string[]).includes(st)) return st as EngineWord;
  const b = bucket.trim().toLowerCase();
  if (b === 'unsupported') return 'unverified';
  if (b === 'unchecked') return 'unchecked';
  if ((ENGINE_WORDS as readonly string[]).includes(b)) return b as EngineWord;
  if (!st && !b) return 'unknown';
  return 'unknown';
}

export interface ReviewerPair {
  a: string;
  b: string;
  n: number;
  agreements: number;
  agreementRate: number | null;
  cohensKappa: number | null;
}

/** The scan's verdict for one claim id, as the audit report classified it. */
export type ScanVerdict = EngineWord | 'unchecked';

export interface AgreementResult {
  /** Distinct claim ids in the scan. Every one lands in exactly one of the buckets below. */
  scanClaims: number;
  scored: number;
  agreements: number;
  errors: number;
  agreementRate: number | null;
  errorRate: number | null;
  errorRateCi95: [number, number] | null;
  /** Scan claims with no row in the CSV. */
  excludedNotInCsv: number;
  excludedUnchecked: number;
  /** Unchecked claims a reviewer still labelled. They stay out of the error rate. */
  uncheckedButLabelled: number;
  /** One reviewer gave the claim more than one labelled row. */
  excludedConflict: number;
  /** A reviewer label is not one of the accepted words. */
  excludedUnknownLabel: number;
  excludedNoLabel: number;
  excludedNoMajority: number;
  /** Non-empty data rows in the CSV. */
  csvRows: number;
  /** Rows with an empty claim_id. Not scored. */
  rowsNoClaimId: number;
  /** Rows whose claim_id is not a claim in the scan. Not scored. */
  rowsNotInScan: number;
  notInScanClaimIds: string[];
  /** Extra rows with a blank label for a claim and reviewer that already had a row. Ignored. */
  blankDuplicateRows: number;
  /** Rows whose engine_status or engine_bucket differs from the scan. The scan's verdict was used. */
  engineColumnMismatches: number;
  reviewers: string[];
  pairs: ReviewerPair[];
  confusion: Record<EngineWord, Record<EngineWord, number>>;
  bootstrap: {
    resamples: number;
    seed: number;
    rng: 'mulberry32';
    percentile: 'linear';
    unit: 'claim id, sorted';
  };
  conflictClaimIds: string[];
  unknownLabelClaimIds: string[];
  noMajorityClaimIds: string[];
}

function emptyConfusion(): Record<EngineWord, Record<EngineWord, number>> {
  const cell = (): Record<EngineWord, number> => ({ supported: 0, contradicted: 0, mixed: 0, unverified: 0 });
  return { supported: cell(), contradicted: cell(), mixed: cell(), unverified: cell() };
}

function majority(labels: EngineWord[]): EngineWord | null {
  const counts = new Map<EngineWord, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  let best: EngineWord | null = null;
  let bestN = 0;
  let tied = false;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
      tied = false;
    } else if (n === bestN) {
      tied = true;
    }
  }
  return tied ? null : best;
}

function isEngineWord(l: ParsedReviewerLabel): l is EngineWord {
  return l !== 'blank' && l !== 'skip' && l !== 'invalid';
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Score a labelled CSV against the scan it was exported from. The scan's
 * verdict for each claim comes from `scanVerdicts`; the CSV's engine columns
 * are never used for scoring. A CSV row whose claim id is not in the scan is
 * not scored.
 */
export function importReviewerLabels(csvText: string, scanVerdicts: ReadonlyMap<string, ScanVerdict>): AgreementResult {
  const table = parseCsv(csvText);
  if (table.length === 0) throw new AuditLabelError('The CSV has no header row.');
  const header = table[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const idCol = col('claim_id');
  const labelCol = col('reviewer_label');
  if (idCol < 0) throw new AuditLabelError('The CSV is missing the claim_id column.');
  if (labelCol < 0) throw new AuditLabelError('The CSV is missing the reviewer_label column.');
  const statusCol = col('engine_status');
  const bucketCol = col('engine_bucket');
  const reviewerCol = col('reviewer_id');

  let csvRows = 0;
  let rowsNoClaimId = 0;
  let rowsNotInScan = 0;
  let engineColumnMismatches = 0;
  const notInScan = new Set<string>();
  // claim id -> reviewer id -> every label that reviewer gave the claim, in row order.
  const byClaim = new Map<string, Map<string, ParsedReviewerLabel[]>>();
  for (const cells of table.slice(1)) {
    csvRows++;
    const claimId = (cells[idCol] ?? '').trim();
    if (!claimId) {
      rowsNoClaimId++;
      continue;
    }
    const verdict = scanVerdicts.get(claimId);
    if (verdict === undefined) {
      rowsNotInScan++;
      notInScan.add(claimId);
      continue;
    }
    // Each engine column is checked on its own, so a status that agrees with
    // the scan cannot mask a bucket that disagrees.
    const fromStatus = engineWordFromCells(statusCol >= 0 ? cells[statusCol] ?? '' : '', '');
    const fromBucket = engineWordFromCells('', bucketCol >= 0 ? cells[bucketCol] ?? '' : '');
    if ((fromStatus !== 'unknown' && fromStatus !== verdict) || (fromBucket !== 'unknown' && fromBucket !== verdict)) {
      engineColumnMismatches++;
    }
    const reviewerId = (reviewerCol >= 0 ? cells[reviewerCol] ?? '' : '').trim() || 'reviewer';
    const reviewers = byClaim.get(claimId) ?? new Map<string, ParsedReviewerLabel[]>();
    const labels = reviewers.get(reviewerId) ?? [];
    labels.push(parseReviewerLabel(cells[labelCol] ?? ''));
    reviewers.set(reviewerId, labels);
    byClaim.set(claimId, reviewers);
  }
  if (csvRows === 0) throw new AuditLabelError('The CSV has no claim rows.');

  // One label per claim and reviewer. Two or more non-blank rows from one reviewer are a conflict.
  let blankDuplicateRows = 0;
  const finalLabels = new Map<string, Map<string, ParsedReviewerLabel>>();
  const conflicted = new Set<string>();
  for (const [claimId, reviewers] of byClaim) {
    const final = new Map<string, ParsedReviewerLabel>();
    for (const [reviewerId, labels] of reviewers) {
      const labelled = labels.filter((l) => l !== 'blank');
      if (labelled.length > 1) {
        conflicted.add(claimId);
        continue;
      }
      blankDuplicateRows += labels.length - 1;
      final.set(reviewerId, labelled[0] ?? 'blank');
    }
    finalLabels.set(claimId, final);
  }

  const claimIds = [...scanVerdicts.keys()].sort(byCodeUnit);

  let excludedNotInCsv = 0;
  let excludedUnchecked = 0;
  let uncheckedButLabelled = 0;
  let excludedNoLabel = 0;
  let excludedNoMajority = 0;
  const conflictClaimIds: string[] = [];
  const unknownLabelClaimIds: string[] = [];
  const noMajorityClaimIds: string[] = [];
  const scored: Array<{ id: string; engine: EngineWord; label: EngineWord; error: boolean }> = [];

  for (const id of claimIds) {
    const engine = scanVerdicts.get(id)!;
    const final = finalLabels.get(id);
    if (!final) {
      excludedNotInCsv++;
      continue;
    }
    const labels = [...final.values()];
    if (engine === 'unchecked') {
      excludedUnchecked++;
      if (conflicted.has(id) || labels.some((l) => l !== 'blank' && l !== 'skip')) uncheckedButLabelled++;
      continue;
    }
    if (conflicted.has(id)) {
      conflictClaimIds.push(id);
      continue;
    }
    if (labels.some((l) => l === 'invalid')) {
      unknownLabelClaimIds.push(id);
      continue;
    }
    const readable = labels.filter(isEngineWord);
    if (readable.length === 0) {
      excludedNoLabel++;
      continue;
    }
    const label = majority(readable);
    if (!label) {
      excludedNoMajority++;
      noMajorityClaimIds.push(id);
      continue;
    }
    scored.push({ id, engine, label, error: engine !== label });
  }

  const confusion = emptyConfusion();
  for (const s of scored) confusion[s.engine][s.label]++;

  const agreements = scored.filter((s) => !s.error).length;
  const errors = scored.length - agreements;
  let agreementRate: number | null = null;
  let errorRate: number | null = null;
  let errorRateCi95: [number, number] | null = null;
  if (scored.length > 0) {
    const boot = bootstrapRate(scored.map((s) => s.error));
    agreementRate = agreements / scored.length;
    errorRate = boot.rate;
    errorRateCi95 = boot.ci95;
  }

  const reviewerSet = new Set<string>();
  for (const reviewers of byClaim.values()) for (const r of reviewers.keys()) reviewerSet.add(r);
  const reviewers = [...reviewerSet].sort(byCodeUnit);

  const pairs: ReviewerPair[] = [];
  for (let i = 0; i < reviewers.length; i++) {
    for (let j = i + 1; j < reviewers.length; j++) {
      const a = reviewers[i];
      const b = reviewers[j];
      const left: string[] = [];
      const right: string[] = [];
      for (const id of claimIds) {
        if (conflicted.has(id)) continue;
        const final = finalLabels.get(id);
        const la = final?.get(a);
        const lb = final?.get(b);
        if (!la || !lb || !isEngineWord(la) || !isEngineWord(lb)) continue;
        left.push(la);
        right.push(lb);
      }
      const n = left.length;
      const agreeN = left.filter((l, k) => l === right[k]).length;
      pairs.push({
        a,
        b,
        n,
        agreements: agreeN,
        agreementRate: n === 0 ? null : agreeN / n,
        cohensKappa: cohensKappa(left, right),
      });
    }
  }

  return {
    scanClaims: claimIds.length,
    scored: scored.length,
    agreements,
    errors,
    agreementRate,
    errorRate,
    errorRateCi95,
    excludedNotInCsv,
    excludedUnchecked,
    uncheckedButLabelled,
    excludedConflict: conflictClaimIds.length,
    excludedUnknownLabel: unknownLabelClaimIds.length,
    excludedNoLabel,
    excludedNoMajority,
    csvRows,
    rowsNoClaimId,
    rowsNotInScan,
    notInScanClaimIds: [...notInScan].sort(byCodeUnit),
    blankDuplicateRows,
    engineColumnMismatches,
    reviewers,
    pairs,
    confusion,
    bootstrap: {
      resamples: BOOTSTRAP_RESAMPLES,
      seed: BOOTSTRAP_SEED,
      rng: 'mulberry32',
      percentile: 'linear',
      unit: 'claim id, sorted',
    },
    conflictClaimIds,
    unknownLabelClaimIds,
    noMajorityClaimIds,
  };
}

/** Characters that start Markdown links, emphasis or code, plus the table pipe. */
const MARKDOWN_PUNCTUATION = '\\|[]()*_`';

/**
 * One line of untrusted text for a Markdown table cell or paragraph.
 * Whitespace is collapsed, `&`, `<` and `>` become character references (so
 * raw HTML stays text), and the characters that start a link, emphasis, code
 * span or a table column are backslash-escaped. The backslash itself is
 * escaped too, so a backslash in the text cannot undo the escape after it.
 */
export function markdownCell(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 38) out += '&' + 'amp;';
    else if (code === 60) out += '&' + 'lt;';
    else if (code === 62) out += '&' + 'gt;';
    else if (MARKDOWN_PUNCTUATION.includes(s[i])) out += '\\' + s[i];
    else out += s[i];
  }
  return out;
}

function idList(ids: readonly string[]): string {
  return ids.map(markdownCell).join(', ');
}

export function formatQuotient(numer: number, denom: number): string {
  if (denom === 0) return 'not computed';
  return `${numer}/${denom} = ${String(numer / denom)}`;
}

export function formatAgreementMarkdown(result: AgreementResult): string {
  const lines: string[] = [];
  lines.push('# Reviewer labels');
  lines.push('');
  lines.push(`Claims in the scan: ${result.scanClaims}`);
  lines.push(`Data rows in the CSV: ${result.csvRows}`);
  lines.push(`Scored claims: ${result.scored} of ${result.scanClaims}`);
  lines.push(`Agreements with the scan: ${result.scored === 0 ? 'not computed' : String(result.agreements)}`);
  lines.push(`Errors: ${result.scored === 0 ? 'not computed' : String(result.errors)}`);
  lines.push('');
  lines.push('Each claim in the scan is scored or excluded for one reason:');
  lines.push('');
  lines.push(`- Excluded, the scan did not check the claim: ${result.excludedUnchecked}`);
  if (result.uncheckedButLabelled > 0) {
    lines.push(`  Of those, ${result.uncheckedButLabelled} had a reviewer label and were still excluded.`);
  }
  lines.push(`- Excluded, no row in the CSV: ${result.excludedNotInCsv}`);
  lines.push(
    `- Excluded, conflict (one reviewer gave the claim more than one labelled row): ${result.excludedConflict}` +
      (result.conflictClaimIds.length > 0 ? `. Claim ids: ${idList(result.conflictClaimIds)}` : ''),
  );
  lines.push(
    `- Excluded, unknown label: ${result.excludedUnknownLabel}` +
      (result.unknownLabelClaimIds.length > 0 ? `. Claim ids: ${idList(result.unknownLabelClaimIds)}` : ''),
  );
  lines.push(`- Excluded, no reviewer label (blank or skip): ${result.excludedNoLabel}`);
  lines.push(
    `- Excluded, reviewers tied with no majority: ${result.excludedNoMajority}` +
      (result.noMajorityClaimIds.length > 0 ? `. Claim ids: ${idList(result.noMajorityClaimIds)}` : ''),
  );
  lines.push('');
  lines.push('CSV rows that are not a claim in the scan are not scored:');
  lines.push('');
  lines.push(`- Rows with no claim id: ${result.rowsNoClaimId}`);
  lines.push(
    `- Rows whose claim id is not in the scan: ${result.rowsNotInScan}, ${result.notInScanClaimIds.length} distinct claim ids` +
      (result.notInScanClaimIds.length > 0 ? `: ${idList(result.notInScanClaimIds)}` : ''),
  );
  lines.push(`- Extra rows with a blank label for a claim and reviewer that already had a row, ignored: ${result.blankDuplicateRows}`);
  lines.push(`- Rows whose engine columns differ from the scan (the scan's verdict was used): ${result.engineColumnMismatches}`);
  lines.push('');
  lines.push('## Agreement with the scan');
  lines.push('');
  if (result.errorRate === null || result.errorRateCi95 === null) {
    lines.push('The error rate was not computed. No checked claim had a usable reviewer label.');
  } else {
    lines.push(`Agreement rate: ${formatQuotient(result.agreements, result.scored)}`);
    lines.push(`Error rate: ${formatQuotient(result.errors, result.scored)}`);
    lines.push(`95% bootstrap CI: [${String(result.errorRateCi95[0])}, ${String(result.errorRateCi95[1])}]`);
  }
  lines.push('');
  lines.push(
    'The error rate is the share of scored claims whose reviewer label differs from the scan\'s verdict. ' +
      'When more than one reviewer labelled a claim, the label is their majority; a tie is excluded. ' +
      'The scan\'s verdict for each claim is read from the scan file; the CSV\'s engine columns are not used for scoring. ' +
      'The four words are supported, contradicted, mixed and unverified. A reviewer\'s "unsupported" is read as unverified, and "refuted" as contradicted. ' +
      'A claim the scan did not check is excluded, including when a reviewer labelled it.',
  );
  lines.push('');
  lines.push(
    `Bootstrap: ${result.bootstrap.resamples} resamples of scored claims, sorted by claim id, seed ${result.bootstrap.seed}, ` +
      `${result.bootstrap.rng}, index floor(u * n), 95% interval by ${result.bootstrap.percentile} percentile. ` +
      'This generator is not the numpy generator used for the published balanced-accuracy interval, and this rate is not balanced accuracy.',
  );
  lines.push('');
  lines.push('## Reviewer agreement');
  lines.push('');
  if (result.reviewers.length < 2) {
    lines.push(
      `Reviewers in the file: ${idList(result.reviewers) || 'none'}. Inter-reviewer agreement was not computed.`,
    );
  } else {
    lines.push('| Reviewers | Claims both labelled | Agreement | Cohen\'s kappa |');
    lines.push('|-----------|----------------------|-----------|----------------|');
    for (const p of result.pairs) {
      const rate = p.agreementRate === null ? 'not computed' : formatQuotient(p.agreements, p.n);
      const kappa = p.cohensKappa === null ? 'undefined (chance agreement is 1)' : String(p.cohensKappa);
      lines.push(`| ${markdownCell(p.a)} vs ${markdownCell(p.b)} | ${p.n} | ${rate} | ${kappa} |`);
    }
  }
  lines.push('');
  lines.push('## Confusion');
  lines.push('');
  lines.push('Rows are the scan\'s verdict. Columns are the reviewer label.');
  lines.push('');
  lines.push('| Scan \\ reviewer | supported | contradicted | mixed | unverified |');
  lines.push('|-----------------|-----------|--------------|-------|------------|');
  for (const word of ENGINE_WORDS) {
    const row = result.confusion[word];
    lines.push(`| ${word} | ${row.supported} | ${row.contradicted} | ${row.mixed} | ${row.unverified} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function formatAgreementJson(result: AgreementResult): string {
  return JSON.stringify({
    ...result,
    method:
      'Exact-match error rate of the scan verdict, read from the scan file, against reviewer labels on checked claims. ' +
      'Not the published balanced accuracy. Bootstrap is mulberry32, seed 20260929, 2000 resamples, linear percentile, claims sorted by id.',
  }, null, 2) + '\n';
}
