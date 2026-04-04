/**
 * CRUCIBLE Gate 6 hardening for eu_ai_act.ts (N-211 candidate).
 *
 * Baseline: 38.85% (Cycle 80, 2026-04-04) — 85 survived / 54 killed.
 * Root cause: tests assert riskLevel but not matchedPatterns articleRef/annexRef
 * strings or confidenceScore values.
 *
 * Kill strategy:
 * - Assert result.matchedPatterns[0] === specific articleRef/annexRef
 *   (kills StringLiteral and ObjectLiteral→{} on each UNACCEPTABLE_PATTERNS /
 *    HIGH_RISK_DOMAINS entry)
 * - Assert result.confidenceScore (kills numeric literal mutations: 0.95/0.9/0.7/0.85/0.6/0.3)
 * - Assert both branches of isEscalated condition (importance >= 4 + contradicted)
 * - Assert regex specificity (claim texts that exercise .* and alternation groups)
 */

import { describe, it, expect } from 'vitest';
import type { Claim, VerificationResult } from '../types';
import { mapClaimToRiskCategory } from '../compliance/eu_ai_act';

function makeClaim(text: string, importance = 3): Claim {
  return { id: 'c1', text, type: 'fact', importance };
}

function makeVerification(status: VerificationResult['status'] = 'supported'): VerificationResult {
  return { claimId: 'c1', status, explanation: 'Test.', sources: [] };
}

// ── UNACCEPTABLE_PATTERNS: articleRef StringLiteral + ObjectLiteral kills ──────

describe('eu_ai_act hardening — UNACCEPTABLE_PATTERNS articleRef values', () => {
  it('EH-U1: social scoring → matchedPatterns[0] === Article 5(1)(c), confidence high, score 0.95', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('The system uses social scoring to rank citizens.'),
      makeVerification(),
    );
    expect(result.matchedPatterns[0]).toBe('Article 5(1)(c)');
    expect(result.confidence).toBe('high');
    expect(result.confidenceScore).toBe(0.95);
  });

  it('EH-U2: citizen score → matchedPatterns[0] === Article 5(1)(c) (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('A citizen score determines access to public services.'),
      makeVerification(),
    );
    expect(result.matchedPatterns[0]).toBe('Article 5(1)(c)');
  });

  it('EH-U3: social credit → matchedPatterns[0] === Article 5(1)(c) (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Social credit rewards compliant behaviour.'),
      makeVerification(),
    );
    expect(result.matchedPatterns[0]).toBe('Article 5(1)(c)');
  });

  it('EH-U4: subliminal manipulation → matchedPatterns[0] === Article 5(1)(a)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Subliminal messages manipulate users beyond their awareness.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('unacceptable');
    expect(result.matchedPatterns[0]).toBe('Article 5(1)(a)');
    expect(result.confidenceScore).toBe(0.95);
  });

  it('EH-U5: exploit disability → matchedPatterns[0] === Article 5(1)(b)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('The system exploits the disability of elderly users.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('unacceptable');
    expect(result.matchedPatterns[0]).toBe('Article 5(1)(b)');
    expect(result.confidenceScore).toBe(0.95);
  });

  it('EH-U6: exploit age → matchedPatterns[0] === Article 5(1)(b) (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('The AI exploits age to target children with manipulative ads.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('unacceptable');
    expect(result.matchedPatterns[0]).toBe('Article 5(1)(b)');
  });

  it('EH-U7: mass surveillance → matchedPatterns[0] === Article 5(1)(d)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Mass surveillance cameras track all residents.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('unacceptable');
    expect(result.matchedPatterns[0]).toBe('Article 5(1)(d)');
    expect(result.confidenceScore).toBe(0.95);
  });

  it('EH-U8: real-time biometric in public → matchedPatterns[0] === Article 5(1)(d) (kills .? quantifier)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Real-time biometric identification in public spaces deployed.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('unacceptable');
    expect(result.matchedPatterns[0]).toBe('Article 5(1)(d)');
  });

  it('EH-U9: emotion recognition in workplace → matchedPatterns[0] === Article 5(1)(f)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Emotion recognition in the workplace monitors staff morale.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('unacceptable');
    expect(result.matchedPatterns[0]).toBe('Article 5(1)(f)');
    expect(result.confidenceScore).toBe(0.95);
  });

  it('EH-U10: emotion recognition in education → matchedPatterns[0] === Article 5(1)(f) (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Emotion recognition used in education to monitor student engagement.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('unacceptable');
    expect(result.matchedPatterns[0]).toBe('Article 5(1)(f)');
  });

  it('EH-U11: unacceptable → exactly 1 matchedPattern (early return, not accumulated)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Social scoring in education violates rights.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('unacceptable');
    expect(result.matchedPatterns).toHaveLength(1);
  });
});

// ── HIGH_RISK_DOMAINS: annexRef StringLiteral + ObjectLiteral kills ────────────

describe('eu_ai_act hardening — HIGH_RISK_DOMAINS annexRef values', () => {
  it('EH-H1: facial recognition → matchedPatterns includes Annex III §1', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Facial recognition identifies suspects at border checkpoints.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.matchedPatterns).toContain('Annex III §1');
  });

  it('EH-H2: biometric → matchedPatterns includes Annex III §1 (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Biometric data collected during onboarding.'),
      makeVerification(),
    );
    expect(result.matchedPatterns).toContain('Annex III §1');
  });

  it('EH-H3: critical infrastructure → matchedPatterns includes Annex III §2', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('AI manages the energy grid load balancing.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.matchedPatterns).toContain('Annex III §2');
  });

  it('EH-H4: transport safety → matchedPatterns includes Annex III §2 (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('AI controls transport safety signalling systems.'),
      makeVerification(),
    );
    expect(result.matchedPatterns).toContain('Annex III §2');
  });

  it('EH-H5: student admission → matchedPatterns includes Annex III §3', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('AI scores student admission applications for universities.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.matchedPatterns).toContain('Annex III §3');
  });

  it('EH-H6: academic scoring → matchedPatterns includes Annex III §3 (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Academic scoring algorithm ranks students nationally.'),
      makeVerification(),
    );
    expect(result.matchedPatterns).toContain('Annex III §3');
  });

  it('EH-H7: recruitment/hiring → matchedPatterns includes Annex III §4', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('The recruitment tool screens candidates for hiring decisions.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.matchedPatterns).toContain('Annex III §4');
  });

  it('EH-H8: worker management → matchedPatterns includes Annex III §4 (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('AI monitors worker performance and productivity.'),
      makeVerification(),
    );
    expect(result.matchedPatterns).toContain('Annex III §4');
  });

  it('EH-H9: credit scoring → matchedPatterns includes Annex III §5', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('AI determines credit scoring for personal loan applicants.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.matchedPatterns).toContain('Annex III §5');
  });

  it('EH-H10: insurance risk → matchedPatterns includes Annex III §5 (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('AI evaluates insurance risk for health premiums.'),
      makeVerification(),
    );
    expect(result.matchedPatterns).toContain('Annex III §5');
  });

  it('EH-H11: predictive policing → matchedPatterns includes Annex III §6', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Predictive policing deployed across metropolitan police force.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.matchedPatterns).toContain('Annex III §6');
  });

  it('EH-H12: criminal justice AI → matchedPatterns includes Annex III §6 (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('AI assesses criminal recidivism risk for parole decisions.'),
      makeVerification(),
    );
    // Note: 'criminal' matches §6; 'parole' matches §8 — both may appear
    expect(result.matchedPatterns.some(p => p === 'Annex III §6')).toBe(true);
  });

  it('EH-H13: migration/asylum → matchedPatterns includes Annex III §7', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('AI screens asylum applications at the border control.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.matchedPatterns).toContain('Annex III §7');
  });

  it('EH-H14: visa processing → matchedPatterns includes Annex III §7 (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Automated visa processing evaluates applicant eligibility.'),
      makeVerification(),
    );
    expect(result.matchedPatterns).toContain('Annex III §7');
  });

  it('EH-H15: judicial/sentencing AI → matchedPatterns includes Annex III §8', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('AI assists judicial sentencing determinations.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.matchedPatterns).toContain('Annex III §8');
  });

  it('EH-H16: election/voting AI → matchedPatterns includes Annex III §8 (kills alternation)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('AI targets voting behaviour with personalised political campaign content.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.matchedPatterns).toContain('Annex III §8');
  });

  it('EH-H17: multiple domain matches → matchedPatterns.length > 1', () => {
    // 'facial recognition' (§1) + 'employment' (§4)
    const result = mapClaimToRiskCategory(
      makeClaim('Facial recognition used in employment screening at workplace entry.'),
      makeVerification(),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.matchedPatterns.length).toBeGreaterThan(1);
  });
});

// ── isEscalated: confidenceScore 0.9 vs 0.7 ──────────────────────────────────

describe('eu_ai_act hardening — isEscalated confidence scoring', () => {
  it('EH-E1: importance=4 + contradicted → escalated: confidenceScore 0.9, confidence high', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('The hiring AI is completely unbiased.', 4),
      makeVerification('contradicted'),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.confidence).toBe('high');
    expect(result.confidenceScore).toBe(0.9);
  });

  it('EH-E2: importance=5 + contradicted → escalated (kills importance >= 4 boundary)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('The biometric system has zero false positives.', 5),
      makeVerification('contradicted'),
    );
    expect(result.confidence).toBe('high');
    expect(result.confidenceScore).toBe(0.9);
  });

  it('EH-E3: importance=3 + contradicted → NOT escalated: confidenceScore 0.7, confidence medium (kills >= 4 comparison)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('The hiring algorithm is thoroughly tested.', 3),
      makeVerification('contradicted'),
    );
    expect(result.riskLevel).toBe('high');
    expect(result.confidence).toBe('medium');
    expect(result.confidenceScore).toBe(0.7);
  });

  it('EH-E4: importance=4 + supported → NOT escalated (kills contradicted check in isEscalated)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('The recruitment AI passed all audits.', 4),
      makeVerification('supported'),
    );
    expect(result.confidence).toBe('medium');
    expect(result.confidenceScore).toBe(0.7);
  });
});

// ── limited / minimal confidenceScore kills ───────────────────────────────────

describe('eu_ai_act hardening — limited and minimal confidenceScore values', () => {
  it('EH-L1: contradicted generic → confidenceScore 0.85 (kills 0.85 literal)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Paris has 50 million residents.'),
      makeVerification('contradicted'),
    );
    expect(result.riskLevel).toBe('limited');
    expect(result.confidenceScore).toBe(0.85);
    expect(result.matchedPatterns).toContain('Article 50 (AI-generated content)');
  });

  it('EH-L2: mixed generic → confidenceScore 0.6 (kills 0.6 literal)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('GDP grew 3% last quarter.'),
      makeVerification('mixed'),
    );
    expect(result.riskLevel).toBe('limited');
    expect(result.confidenceScore).toBe(0.6);
  });

  it('EH-L3: limited matchedPatterns contains Article 50 string (kills StringLiteral)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('The sky is green.'),
      makeVerification('contradicted'),
    );
    expect(result.matchedPatterns[0]).toBe('Article 50 (AI-generated content)');
  });

  it('EH-M1: minimal (supported, no domain) → confidenceScore 0.3 (kills 0.3 literal)', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Water boils at 100°C at sea level.'),
      makeVerification('supported'),
    );
    expect(result.riskLevel).toBe('minimal');
    expect(result.confidence).toBe('low');
    expect(result.confidenceScore).toBe(0.3);
    expect(result.matchedPatterns).toEqual([]);
  });

  it('EH-M2: unverified generic → minimal, confidenceScore 0.3', () => {
    const result = mapClaimToRiskCategory(
      makeClaim('Some obscure fact.'),
      makeVerification('unverified'),
    );
    expect(result.riskLevel).toBe('minimal');
    expect(result.confidenceScore).toBe(0.3);
  });
});
