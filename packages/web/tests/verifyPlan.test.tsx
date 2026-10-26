/**
 * Claims about the document itself are never sent to a provider from the web app.
 * The same check (packages/cli/lib/claim-scope.ts) guards the CLI and the API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Claim, VerificationResult } from '../types';

const mocks = vi.hoisted(() => ({
  extractClaims: vi.fn(),
  verifyClaim: vi.fn(),
  generateCritiqueAndPrompt: vi.fn(),
}));
vi.mock('../services/geminiService', () => mocks);

import App from '../App';
import { planVerification, calculateRisk } from '../services/verifyPlan';

const DOC_CLAIM: Claim = { id: 'doc', text: 'This report covers three models.', type: 'fact', importance: 5 };
const ATTRIBUTED: Claim = { id: 'attr', text: 'The report concludes that smoking causes lung cancer.', type: 'fact', importance: 4 };
const WORLD: Claim = { id: 'world', text: 'Mistral 7B was released in September 2023.', type: 'fact', importance: 4 };

/** A verifier that would contradict every claim it is given. */
const contradictAll = async (claim: Claim): Promise<VerificationResult> => ({
  claimId: claim.id, status: 'contradicted', explanation: 'Contradicted.', sources: [],
});

describe('planVerification', () => {
  it('never queues a document-scope claim and marks it skipped with the scope explanation', () => {
    const plan = planVerification([DOC_CLAIM, ATTRIBUTED, WORLD]);
    expect(plan.claimsToVerify.map((c) => c.id)).toEqual(['attr', 'world']);
    expect(plan.claims.find((c) => c.id === 'doc')?.scope).toBe('document');
    expect(plan.claims.find((c) => c.id === 'attr')?.scope).toBeUndefined();
    expect(plan.initialVerifications.doc).toMatchObject({ status: 'skipped' });
    expect(plan.initialVerifications.doc.explanation).toMatch(/About this document/);
    expect(plan.initialVerifications.attr.status).toBe('loading');
  });

  it('a document claim adds nothing to risk even though the verifier would contradict it', () => {
    const plan = planVerification([DOC_CLAIM, WORLD]);
    const verifications = { ...plan.initialVerifications };
    for (const c of plan.claimsToVerify) {
      verifications[c.id] = { claimId: c.id, status: c.id === 'doc' ? 'contradicted' : 'supported', explanation: '', sources: [] };
    }
    expect(Object.values(verifications).filter((v) => v.status === 'contradicted')).toHaveLength(0);
    expect(calculateRisk(verifications)).toBe('low');
  });
});

describe('App: the web verification entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('faultline_has_seen_tour', 'true');
    process.env.API_KEY = 'test-key';
    mocks.extractClaims.mockResolvedValue([DOC_CLAIM, WORLD]);
    mocks.verifyClaim.mockImplementation(contradictAll);
    mocks.generateCritiqueAndPrompt.mockResolvedValue({ critique: 'ok', improvedPrompt: 'ok' });
  });

  it('sends only the world claim to the provider and shows the document claim without a verdict', async () => {
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/Paste an AI answer/), { target: { value: 'Some text.' } });
    fireEvent.click(screen.getByText('Run Seismic Survey'));
    await waitFor(() => expect(mocks.generateCritiqueAndPrompt).toHaveBeenCalled());

    expect(mocks.verifyClaim).toHaveBeenCalledTimes(1);
    expect(mocks.verifyClaim.mock.calls[0][0]).toMatchObject({ id: 'world' });
    expect(mocks.generateCritiqueAndPrompt.mock.calls[0][1].map((c: Claim) => c.id)).toEqual(['world']);
    expect(await screen.findByText(/About this document, not a claim about the world/)).toBeInTheDocument();
  });
});
