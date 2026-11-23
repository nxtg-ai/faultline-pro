/**
 * A delivered scan names the engine commit that ran it, so an audit report of
 * the scan can name it too. Before this the audit report printed "Engine commit
 * recorded: unknown" for hosted scans while GET /health reported the commit.
 * The value is the same one /health reports: FAULTLINE_GIT_SHA when it is a hex sha.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { issueScanId } from '../src/lib/scan-access.js';

const saved = process.env.FAULTLINE_GIT_SHA;
afterEach(() => {
  if (saved === undefined) delete process.env.FAULTLINE_GIT_SHA;
  else process.env.FAULTLINE_GIT_SHA = saved;
});

describe('issueScanId engine commit', () => {
  it('stamps the build commit on the delivered scan', () => {
    process.env.FAULTLINE_GIT_SHA = '88C4350DB33D22D8479DF94D1A91CF8DF50BB5FC';
    const out = issueScanId({ input: 'x', claims: [] }, undefined);
    expect(out.scanId).toMatch(/^scan-/);
    expect((out as Record<string, unknown>).engineCommit).toBe('88c4350db33d22d8479df94d1a91cf8df50bb5fc');
    expect((out as Record<string, unknown>).input).toBe('x');
  });

  it('adds no field when the build recorded no commit, or recorded something that is not a sha', () => {
    for (const value of [undefined, '', '<script>', 'main']) {
      if (value === undefined) delete process.env.FAULTLINE_GIT_SHA;
      else process.env.FAULTLINE_GIT_SHA = value;
      const out = issueScanId({ input: 'x' }, undefined);
      expect('engineCommit' in out).toBe(false);
    }
  });
});
