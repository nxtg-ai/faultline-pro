/**
 * Document-scope check against a private fixture, run only when one is supplied.
 *
 * Set FAULTLINE_PRIVATE_SCOPE_FIXTURE to a readable JSON file of the shape
 * `{ claims: [{ id, text, type, importance }], verifications: { [id]: { status } } }`.
 * Claims "c2" and "c3" must be document-relative and no other claim may be.
 * Never commit a fixture for this test: the real text is private. Failure
 * messages name claim ids only, never claim text.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { isDocumentRelative } from '../lib/claim-scope.js';

interface PrivateFixture {
  claims: Array<{ id: string; text: string; type: string; importance: number }>;
  verifications: Record<string, { status: string }>;
}

const FIXTURE_PATH = process.env.FAULTLINE_PRIVATE_SCOPE_FIXTURE;
const EXPECTED_DOCUMENT_IDS = ['c2', 'c3'];

describe('document scope on the private fixture', () => {
  it.skipIf(!FIXTURE_PATH)('flags exactly c2 and c3 as document-relative', () => {
    const path = FIXTURE_PATH as string;
    expect(existsSync(path), 'FAULTLINE_PRIVATE_SCOPE_FIXTURE must name a readable file').toBe(true);
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as PrivateFixture;
    expect(Array.isArray(fixture.claims) && fixture.claims.length > 0, 'fixture has claims').toBe(true);

    const ids = fixture.claims.map((c) => c.id);
    for (const id of EXPECTED_DOCUMENT_IDS) expect(ids, `fixture contains ${id}`).toContain(id);

    for (const claim of fixture.claims) {
      const expected = EXPECTED_DOCUMENT_IDS.includes(claim.id);
      expect(isDocumentRelative(claim.text), `claim ${claim.id} document-relative should be ${expected}`).toBe(expected);
    }
  });
});
