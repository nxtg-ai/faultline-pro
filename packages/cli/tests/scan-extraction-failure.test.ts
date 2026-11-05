/**
 * A scan never completes on synthetic claims after a failed extraction.
 *
 * guaranteeClaimPerSentence fills one synthetic claim per unrepresented
 * sentence. Fed the [] a failed extraction used to return, it turned every
 * sentence into a claim that was then verified (quick scan) or priced (full
 * scan estimate). scan() and extractForFullScan must let the ExtractionError
 * through and make no verify call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Claim, VerificationResult } from '../types.js';

const { mockExtractClaims, mockVerifyClaim } = vi.hoisted(() => ({
  mockExtractClaims: vi.fn(),
  mockVerifyClaim: vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn(() => ({
    name: 'extraction-failure-test-provider',
    modelId: 'extraction-failure-v1',
    extractClaims: mockExtractClaims,
    verifyClaim: mockVerifyClaim,
    generateCritiqueAndPrompt: vi.fn().mockResolvedValue({ critique: '', improvedPrompt: '' }),
  })),
}));

import { scan, extractForFullScan } from '../cli/scan.js';
import { ExtractionError } from '../providers/extraction-error.js';

/** Three sentences: a [] extraction would have become three synthetic claims. */
const THREE_SENTENCES = 'The Eiffel Tower is in Paris. It was completed in 1889. It is about 330 metres tall.';

function supported(claim: Claim): VerificationResult {
  return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyClaim.mockImplementation(async (c: Claim) => supported(c));
});

describe('scan() after a failed extraction', () => {
  it('quick scan rejects with the ExtractionError and verifies nothing', async () => {
    const failure = new ExtractionError('invalid_output', new SyntaxError('Unterminated string in JSON at position 4096'));
    mockExtractClaims.mockRejectedValueOnce(failure);

    await expect(scan(THREE_SENTENCES, 'mock')).rejects.toBe(failure);
    expect(mockExtractClaims).toHaveBeenCalledTimes(1);
    expect(mockVerifyClaim).not.toHaveBeenCalled();
  });

  it('full scan (mode full) rejects and verifies nothing', async () => {
    mockExtractClaims.mockRejectedValueOnce(new ExtractionError('rate_limited', new Error('429')));

    await expect(scan(THREE_SENTENCES, 'mock', undefined, undefined, undefined, undefined, undefined, { mode: 'full' }))
      .rejects.toMatchObject({ name: 'ExtractionError', reason: 'rate_limited' });
    expect(mockVerifyClaim).not.toHaveBeenCalled();
  });

  it('never reports progress past extraction or fires a claim callback', async () => {
    mockExtractClaims.mockRejectedValueOnce(new ExtractionError('provider_unavailable'));
    const onProgress = vi.fn();
    const onClaim = vi.fn();

    await expect(scan(THREE_SENTENCES, 'mock', undefined, undefined, onProgress, onClaim)).rejects.toBeInstanceOf(ExtractionError);
    expect(onProgress.mock.calls.map(([m]) => m)).toEqual(['Extracting claims...']);
    expect(onClaim).not.toHaveBeenCalled();
  });

  it('control: a valid empty extraction still completes, with sentence-guarantee claims', async () => {
    mockExtractClaims.mockResolvedValueOnce([]);

    const result = await scan(THREE_SENTENCES, 'mock');
    expect(result.claims.length).toBe(3);
    expect(result.claims.every((c) => c.id.startsWith('s'))).toBe(true);
    expect(mockVerifyClaim).toHaveBeenCalled();
  });
});

describe('extractForFullScan() after a failed extraction', () => {
  it('rejects with the ExtractionError instead of pricing synthetic claims', async () => {
    const failure = new ExtractionError('invalid_output');
    mockExtractClaims.mockRejectedValueOnce(failure);

    await expect(extractForFullScan(THREE_SENTENCES, 'mock')).rejects.toBe(failure);
    expect(mockVerifyClaim).not.toHaveBeenCalled();
  });

  it('control: a successful extraction is priced on what the model returned', async () => {
    mockExtractClaims.mockResolvedValueOnce([
      { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'It was completed in 1889.', type: 'fact', importance: 3 },
      { id: 'c3', text: 'It is about 330 metres tall.', type: 'fact', importance: 3 },
    ]);

    const estimate = await extractForFullScan(THREE_SENTENCES, 'mock');
    expect(estimate.claims.length).toBe(3);
    expect(estimate.factClaims).toBe(3);
    expect(estimate.claims.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });
});
