import type { ScanResult } from './scan.js';
import type { Claim } from '../types.js';

interface ChangedVerdict {
  claim: Claim;
  before: string;
  after: string;
}

export interface CompareResult {
  newClaims: Claim[];
  removedClaims: Claim[];
  changedVerdicts: ChangedVerdict[];
  trustScoreDelta: number;
  summary: string;
}

const RISK_SCORE: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

export function compareScanResults(before: ScanResult, after: ScanResult): CompareResult {
  const beforeByText = new Map(before.claims.map(c => [normalize(c.text), c]));
  const afterByText  = new Map(after.claims.map(c => [normalize(c.text), c]));

  const newClaims     = after.claims.filter(c => !beforeByText.has(normalize(c.text)));
  const removedClaims = before.claims.filter(c => !afterByText.has(normalize(c.text)));

  const changedVerdicts: ChangedVerdict[] = [];
  for (const [text, claimAfter] of afterByText) {
    const claimBefore = beforeByText.get(text);
    if (!claimBefore) continue;
    const verBefore = before.verifications[claimBefore.id]?.status;
    const verAfter  = after.verifications[claimAfter.id]?.status;
    if (verBefore && verAfter && verBefore !== verAfter) {
      changedVerdicts.push({ claim: claimAfter, before: verBefore, after: verAfter });
    }
  }

  const scoreBefore = RISK_SCORE[before.overallRisk] ?? 0;
  const scoreAfter  = RISK_SCORE[after.overallRisk]  ?? 0;
  const trustScoreDelta = scoreAfter - scoreBefore;

  const summary = trustScoreDelta < 0 ? 'Risk improved'
                : trustScoreDelta > 0 ? 'Risk worsened'
                : 'No change';

  return { newClaims, removedClaims, changedVerdicts, trustScoreDelta, summary };
}

export function renderCompare(result: CompareResult, format: 'text' | 'json' = 'text'): string {
  if (format === 'json') return JSON.stringify(result, null, 2);

  const lines: string[] = ['=== FAULTLINE COMPARE REPORT ===', ''];

  lines.push(`Summary: ${result.summary} (score delta: ${result.trustScoreDelta >= 0 ? '+' : ''}${result.trustScoreDelta})`);
  lines.push('');

  if (result.newClaims.length > 0) {
    lines.push(`New claims (${result.newClaims.length}):`);
    for (const c of result.newClaims) lines.push(`  + [${c.type}] ${c.text}`);
    lines.push('');
  }

  if (result.removedClaims.length > 0) {
    lines.push(`Removed claims (${result.removedClaims.length}):`);
    for (const c of result.removedClaims) lines.push(`  - [${c.type}] ${c.text}`);
    lines.push('');
  }

  if (result.changedVerdicts.length > 0) {
    lines.push(`Changed verdicts (${result.changedVerdicts.length}):`);
    for (const v of result.changedVerdicts) {
      lines.push(`  ~ ${v.claim.text}: ${v.before} → ${v.after}`);
    }
    lines.push('');
  }

  if (result.newClaims.length === 0 && result.removedClaims.length === 0 && result.changedVerdicts.length === 0) {
    lines.push('No differences detected.');
  }

  return lines.join('\n');
}
