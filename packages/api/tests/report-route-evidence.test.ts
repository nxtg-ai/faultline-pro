// Validates: N-234 (per-verdict evidence in every API PDF, GoPMO 1.18.11.5.6; recert P7 NOT FLIPPED on POST /scan/report)
//
// The P7 acceptance re-run (ASIF tmp/reviews/fp/2026-10-20-recert-p1-p7) found that POST /scan/report,
// a separate renderer from the full PDF report, printed only each source's title: no URL, passage or
// fetch time. It now prints them with the same evidenceLine text as the full report. Red before.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import type { FastifyInstance } from 'fastify';

const RESULT = vi.hoisted(() => ({
  provider: 'openai',
  overallRisk: 'low',
  ruleFindings: [],
  claims: [
    { id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 4 },
    { id: 'c2', text: 'The tower is 330 metres tall.', type: 'fact', importance: 3 },
  ],
  verifications: {
    c1: {
      claimId: 'c1', status: 'supported', explanation: 'Completed for the World Fair.',
      sources: [{
        title: 'Beacon Archive', uri: 'https://beacon.example/p7-eiffel',
        evidence: { status: 'ok', passage: 'The tower was completed in March 1889 for the Exposition.', fetchedAt: '2001-02-03T04:05:06.000Z' },
      }],
    },
    c2: {
      claimId: 'c2', status: 'supported', explanation: 'Grounded.',
      sources: [{ title: 'Grounded link', uri: 'https://grounded.example/x', evidence: { status: 'not_fetched', reason: 'provider_terms', passage: null } }],
    },
  },
}));

vi.mock('@nxtg/faultline/cli/scan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nxtg/faultline/cli/scan.js')>()),
  scan: vi.fn(async () => RESULT),
}));

import { buildServer } from '../src/server.js';

let server: FastifyInstance;
beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = 'report-evidence-key';
  server = buildServer();
  await server.ready();
});
afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

describe('POST /scan/report prints per-source evidence', () => {
  it('carries each source URL, the quoted passage with its fetch time, and the provider-terms note', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/report',
      headers: { 'x-api-key': 'report-evidence-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'The Eiffel Tower was completed in 1889. The tower is 330 metres tall.', projectName: 'P7 recert' }),
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const text = (await pdf(res.rawPayload)).text.replace(/\s+/g, ' ');
    expect(text).toContain('P7 recert');
    expect(text).toContain('Sources and evidence');
    expect(text).toContain('https://beacon.example/p7-eiffel');
    expect(text).toContain('The tower was completed in March 1889 for the Exposition.');
    expect(text).toContain('2001-02-03T04:05:06.000Z');
    expect(text).toContain('https://grounded.example/x');
    expect(text).toContain('Passage not retrieved (provider terms)');
  });
});
