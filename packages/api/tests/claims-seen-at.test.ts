// Validates: N-234 (evidence time, not ingestion time, in the claim index; GoPMO 1.18.11.3 P1a; EP4 recert row 2)
import { describe, it, expect, beforeEach } from 'vitest';
import { getClaimIndex, resetClaimIndex } from '../src/store/claims.js';

/** The caller every claim here belongs to: the server key plus a faultline-web user (the claim index is per caller). */
const TEST_CLAIM_CALLER = 'admin\u0000claimtestuser01';


const CLAIM = { id: 'c1', text: 'Seen-at fixture claim about Kestrelvane.', type: 'fact' };
const SOURCE = { title: 'Kestrelvane', uri: 'https://kestrelvane.example/a' };

describe('claim index seenAt', () => {
  beforeEach(() => resetClaimIndex());

  it('records when the evidence was retrieved when the verdict carries it', () => {
    getClaimIndex().ingest([CLAIM], { c1: { status: 'supported', sources: [SOURCE], provenance: { retrievedAt: '2026-10-14T03:01:02.000Z' } } }, 'scan-1', TEST_CLAIM_CALLER);
    const rec = getClaimIndex().search(TEST_CLAIM_CALLER, {}).find(() => true) ?? null;
    const id = (rec as { id?: string } | null)?.id;
    expect(id).toBeDefined();
    const explained = getClaimIndex().explain(id!, TEST_CLAIM_CALLER);
    expect(explained).toBeDefined();
    expect(explained!.evidenceFound).toEqual([{ title: 'Kestrelvane', uri: 'https://kestrelvane.example/a', seenAt: '2026-10-14T03:01:02.000Z' }]);
  });

  it('falls back to the time it was indexed when the verdict has no retrieval time', () => {
    const before = Date.now();
    getClaimIndex().ingest([CLAIM], { c1: { status: 'supported', sources: [SOURCE] } }, 'scan-2', TEST_CLAIM_CALLER);
    const id = (getClaimIndex().search(TEST_CLAIM_CALLER, {}).find(() => true) as { id: string }).id;
    const seenAt = getClaimIndex().explain(id, TEST_CLAIM_CALLER)!.evidenceFound[0].seenAt;
    expect(Date.parse(seenAt)).toBeGreaterThanOrEqual(before);
  });
});
