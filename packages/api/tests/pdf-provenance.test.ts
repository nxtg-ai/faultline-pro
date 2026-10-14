// Validates: N-234 (per-verdict provenance and source URI in the API PDF, GoPMO 1.18.11.3 P1a; EP4 recert 02-codex-evidence.md rows 2-3)
import { describe, it, expect } from 'vitest';
// The lib entry avoids pdf-parse's debug harness in index.js.
import pdf from 'pdf-parse/lib/pdf-parse.js';
import { evidenceLine, generatePdfReport, provenanceLine } from '../src/store/pdf-report.js';

const SCAN = {
  input: 'The Eiffel Tower was completed in 1889.',
  provider: 'gemini',
  overallRisk: 'low',
  scannedAt: '2026-10-14T03:00:00Z',
  claims: [{ id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 4 }],
  verifications: {
    c1: {
      claimId: 'c1',
      status: 'supported',
      explanation: 'Completed for the 1889 World Fair.',
      sources: [{
        title: 'Kestrelvane Archive', uri: 'https://kestrelvane.example/eiffel',
        evidence: { status: 'ok', passage: 'The tower was completed in March 1889 for the Exposition.', fetchedAt: '2026-10-14T03:01:05.000Z' },
      }],
      provenance: { provider: 'gemini', model: 'gemini-2.5-flash-001', verifiedAt: '2026-10-14T03:01:02.000Z', retriever: 'gemini-grounding', retrievedAt: '2026-10-14T03:01:02.000Z' },
    },
  },
};

describe('provenanceLine', () => {
  it('names provider, model and time, and says when retrieval shared the request', () => {
    expect(provenanceLine(SCAN.verifications.c1.provenance)).toBe(
      'Checked by gemini / gemini-2.5-flash-001 at 2026-10-14T03:01:02.000Z (evidence retrieved by gemini-grounding in the same request)',
    );
    expect(provenanceLine({ provider: 'consensus', model: 'openai:a+claude:b', verifiedAt: 'T2', retriever: 'openai-web-search', retrievedAt: 'T1' })).toBe(
      'Checked by consensus / openai:a+claude:b at T2; evidence retrieved by openai-web-search at T1',
    );
    expect(provenanceLine({ provider: 'mock', model: 'm', verifiedAt: 'T' })).toBe('Checked by mock / m at T');
    expect(provenanceLine(undefined)).toBeNull();
  });
});

describe('evidenceLine', () => {
  it('quotes a matched passage with its fetch time, and says why nothing was quoted otherwise', () => {
    expect(evidenceLine({ status: 'ok', passage: 'P.', fetchedAt: 'T' })).toBe('"P." (page read T)');
    expect(evidenceLine({ status: 'no_match', passage: null, fetchedAt: 'T' })).toBe('No passage quoted: page read, no sentence matched the claim (T)');
    expect(evidenceLine({ status: 'blocked', passage: null, fetchedAt: 'T' })).toBe('No passage quoted: address refused (T)');
    expect(evidenceLine(undefined)).toBeNull();
  });
});

describe('API PDF', () => {
  it('prints who checked each claim and when, and each source URI', async () => {
    const buf = await generatePdfReport(SCAN as never);
    const { text } = await pdf(buf);
    const flat = String(text).replace(/\s+/g, ' ');
    expect(flat.length).toBeGreaterThan(0);
    expect(flat).toContain('Checked by gemini / gemini-2.5-flash-001');
    expect(flat).toContain('2026-10-14T03:01:02.000Z');
    expect(flat).toContain('https://kestrelvane.example/eiffel');
    expect(flat).toContain('Kestrelvane Archive');
    // P1b: the passage read from the page, with the time it was read.
    expect(flat).toContain('The tower was completed in March 1889 for the Exposition.');
    expect(flat).toContain('page read 2026-10-14T03:01:05.000Z');
  });

  it('a verdict without provenance prints no Checked by line', async () => {
    const { provenance: _drop, ...bare } = SCAN.verifications.c1;
    const buf = await generatePdfReport({ ...SCAN, verifications: { c1: bare } } as never);
    const { text } = await pdf(buf);
    expect(String(text)).not.toContain('Checked by');
  });
});
