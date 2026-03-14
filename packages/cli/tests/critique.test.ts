import { describe, it, expect } from 'vitest';
import type { Claim, VerificationResult, ClaimStatus } from '../types';
import type { CritiqueResult } from '../providers/base_provider';
import {
  FAILED_STATUSES,
  extractFailedClaims,
  buildCritiqueAnalysis,
  type CritiqueAnalysis,
} from '../analysis/critique';
import { formatCritique } from '../cli/critique';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeClaim(overrides?: Partial<Claim>): Claim {
  return {
    id: 'claim-1',
    text: 'Test claim text.',
    type: 'fact',
    importance: 3,
    ...overrides,
  };
}

function makeVerification(claimId: string, status: ClaimStatus): VerificationResult {
  return {
    claimId,
    status,
    explanation: `Explanation for ${claimId}.`,
    sources: [],
  };
}

function makeCritiqueResult(overrides?: Partial<CritiqueResult>): CritiqueResult {
  return {
    critique: 'Mock assessment: stable.',
    improvedPrompt: 'No changes needed.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. FAILED_STATUSES
// ---------------------------------------------------------------------------

describe('FAILED_STATUSES', () => {
  it('should include contradicted', () => {
    expect(FAILED_STATUSES.has('contradicted')).toBe(true);
  });

  it('should include mixed', () => {
    expect(FAILED_STATUSES.has('mixed')).toBe(true);
  });

  it('should include unverified', () => {
    expect(FAILED_STATUSES.has('unverified')).toBe(true);
  });

  it('should NOT include supported', () => {
    expect(FAILED_STATUSES.has('supported')).toBe(false);
  });

  it('should NOT include loading', () => {
    expect(FAILED_STATUSES.has('loading')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. extractFailedClaims — basics
// ---------------------------------------------------------------------------

describe('extractFailedClaims — basics', () => {
  it('should return empty array for empty claims', () => {
    const result = extractFailedClaims([], {});
    expect(result).toEqual([]);
  });

  it('should exclude claims with no verification entry', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const result = extractFailedClaims(claims, {});
    expect(result).toEqual([]);
  });

  it('should exclude claims with supported status', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'supported') };
    const result = extractFailedClaims(claims, verifications);
    expect(result).toEqual([]);
  });

  it('should include claims with contradicted status', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'contradicted') };
    const result = extractFailedClaims(claims, verifications);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c1');
  });
});

// ---------------------------------------------------------------------------
// 3. extractFailedClaims — all failed statuses
// ---------------------------------------------------------------------------

describe('extractFailedClaims — all failed statuses', () => {
  it('should include contradicted claims', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'contradicted') };
    const result = extractFailedClaims(claims, verifications);
    expect(result).toHaveLength(1);
  });

  it('should include mixed claims', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'mixed') };
    const result = extractFailedClaims(claims, verifications);
    expect(result).toHaveLength(1);
  });

  it('should include unverified claims', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'unverified') };
    const result = extractFailedClaims(claims, verifications);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. extractFailedClaims — preserves order
// ---------------------------------------------------------------------------

describe('extractFailedClaims — preserves order', () => {
  it('should return failed claims in the same order as the input array', () => {
    const claims = [
      makeClaim({ id: 'c1', text: 'First' }),
      makeClaim({ id: 'c2', text: 'Second' }),
      makeClaim({ id: 'c3', text: 'Third' }),
    ];
    const verifications = {
      c1: makeVerification('c1', 'contradicted'),
      c2: makeVerification('c2', 'mixed'),
      c3: makeVerification('c3', 'unverified'),
    };
    const result = extractFailedClaims(claims, verifications);
    expect(result.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('should preserve order even when some claims are not failed', () => {
    const claims = [
      makeClaim({ id: 'c1', text: 'First' }),
      makeClaim({ id: 'c2', text: 'Second' }),
      makeClaim({ id: 'c3', text: 'Third' }),
      makeClaim({ id: 'c4', text: 'Fourth' }),
    ];
    const verifications = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'contradicted'),
      c3: makeVerification('c3', 'supported'),
      c4: makeVerification('c4', 'mixed'),
    };
    const result = extractFailedClaims(claims, verifications);
    expect(result.map((c) => c.id)).toEqual(['c2', 'c4']);
  });
});

// ---------------------------------------------------------------------------
// 5. buildCritiqueAnalysis — counts
// ---------------------------------------------------------------------------

describe('buildCritiqueAnalysis — counts', () => {
  it('should set totalClaims to claims.length including unverified ones', () => {
    const claims = [
      makeClaim({ id: 'c1' }),
      makeClaim({ id: 'c2' }),
      makeClaim({ id: 'c3' }),
    ];
    const verifications = {
      c1: makeVerification('c1', 'supported'),
    };
    const result = buildCritiqueAnalysis(claims, verifications, makeCritiqueResult());
    expect(result.totalClaims).toBe(3);
  });

  it('should set totalVerified to the number of verification entries', () => {
    const claims = [
      makeClaim({ id: 'c1' }),
      makeClaim({ id: 'c2' }),
      makeClaim({ id: 'c3' }),
    ];
    const verifications = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'contradicted'),
    };
    const result = buildCritiqueAnalysis(claims, verifications, makeCritiqueResult());
    expect(result.totalVerified).toBe(2);
  });

  it('should set failedCount to the number of failed claims', () => {
    const claims = [
      makeClaim({ id: 'c1' }),
      makeClaim({ id: 'c2' }),
      makeClaim({ id: 'c3' }),
    ];
    const verifications = {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'contradicted'),
      c3: makeVerification('c3', 'mixed'),
    };
    const result = buildCritiqueAnalysis(claims, verifications, makeCritiqueResult());
    expect(result.failedCount).toBe(2);
  });

  it('should set hasCritique based on critique content', () => {
    const claims = [makeClaim({ id: 'c1' })];
    const verifications = { c1: makeVerification('c1', 'supported') };
    const critique = makeCritiqueResult({ critique: 'Some critique.' });
    const result = buildCritiqueAnalysis(claims, verifications, critique);
    expect(result.hasCritique).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. buildCritiqueAnalysis — hasCritique
// ---------------------------------------------------------------------------

describe('buildCritiqueAnalysis — hasCritique', () => {
  const claims = [makeClaim({ id: 'c1' })];
  const verifications = { c1: makeVerification('c1', 'supported') };

  it('should be false when critique is empty string', () => {
    const result = buildCritiqueAnalysis(
      claims,
      verifications,
      makeCritiqueResult({ critique: '' }),
    );
    expect(result.hasCritique).toBe(false);
  });

  it('should be false when critique is whitespace-only', () => {
    const result = buildCritiqueAnalysis(
      claims,
      verifications,
      makeCritiqueResult({ critique: '   \n\t  ' }),
    );
    expect(result.hasCritique).toBe(false);
  });

  it('should be true when critique has non-whitespace content', () => {
    const result = buildCritiqueAnalysis(
      claims,
      verifications,
      makeCritiqueResult({ critique: 'Needs improvement.' }),
    );
    expect(result.hasCritique).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. buildCritiqueAnalysis — passthrough
// ---------------------------------------------------------------------------

describe('buildCritiqueAnalysis — passthrough', () => {
  const claims = [makeClaim({ id: 'c1' })];
  const verifications = { c1: makeVerification('c1', 'contradicted') };

  it('should pass through critique text from critiqueResult', () => {
    const critique = makeCritiqueResult({ critique: 'Specific critique text here.' });
    const result = buildCritiqueAnalysis(claims, verifications, critique);
    expect(result.critique).toBe('Specific critique text here.');
  });

  it('should pass through improvedPrompt text from critiqueResult', () => {
    const critique = makeCritiqueResult({ improvedPrompt: 'Specific improved prompt.' });
    const result = buildCritiqueAnalysis(claims, verifications, critique);
    expect(result.improvedPrompt).toBe('Specific improved prompt.');
  });
});

// ---------------------------------------------------------------------------
// 8. formatCritique — no failed claims
// ---------------------------------------------------------------------------

describe('formatCritique — no failed claims', () => {
  const analysis: CritiqueAnalysis = {
    failedClaims: [],
    totalClaims: 3,
    totalVerified: 3,
    failedCount: 0,
    hasCritique: false,
    critique: '',
    improvedPrompt: '',
  };

  it('should contain "No failed claims"', () => {
    const output = formatCritique(analysis, 'mock');
    expect(output).toContain('No failed claims');
  });

  it('should NOT contain "CRITIQUE:" section', () => {
    const output = formatCritique(analysis, 'mock');
    expect(output).not.toContain('CRITIQUE:');
  });

  it('should show correct counts in the header', () => {
    const output = formatCritique(analysis, 'mock');
    expect(output).toContain('Claims: 3');
    expect(output).toContain('Verified: 3');
    expect(output).toContain('Failed: 0');
  });
});

// ---------------------------------------------------------------------------
// 9. formatCritique — with failed claims
// ---------------------------------------------------------------------------

describe('formatCritique — with failed claims', () => {
  const failedClaims = [
    makeClaim({ id: 'c1', text: 'The model achieves 99% accuracy on all benchmarks', type: 'fact', importance: 5 }),
    makeClaim({ id: 'c2', text: 'This approach has never been attempted before', type: 'fact', importance: 3 }),
  ];
  const analysis: CritiqueAnalysis = {
    failedClaims,
    totalClaims: 5,
    totalVerified: 3,
    failedCount: 2,
    hasCritique: true,
    critique: 'Mock assessment: stable.',
    improvedPrompt: 'No changes needed.',
  };

  it('should contain "CRITIQUE:" section', () => {
    const output = formatCritique(analysis, 'mock');
    expect(output).toContain('CRITIQUE:');
  });

  it('should contain "IMPROVED PROMPT:" section', () => {
    const output = formatCritique(analysis, 'mock');
    expect(output).toContain('IMPROVED PROMPT:');
  });

  it('should list each failed claim', () => {
    const output = formatCritique(analysis, 'mock');
    expect(output).toContain('The model achieves 99% accuracy on all benchmarks');
    expect(output).toContain('This approach has never been attempted before');
  });

  it('should show correct failed count in header and listing', () => {
    const output = formatCritique(analysis, 'mock');
    expect(output).toContain('Failed: 2');
    expect(output).toContain('Failed claims (2):');
  });

  it('should include summary line', () => {
    const output = formatCritique(analysis, 'mock');
    expect(output).toContain('Summary: 2 failed claim(s).');
    expect(output).toContain('Use the improved prompt above');
  });
});

// ---------------------------------------------------------------------------
// 10. formatCritique — text truncation
// ---------------------------------------------------------------------------

describe('formatCritique — text truncation', () => {
  it('should truncate claim text longer than 80 characters with "..."', () => {
    const longText = 'A'.repeat(100);
    const analysis: CritiqueAnalysis = {
      failedClaims: [makeClaim({ id: 'c1', text: longText })],
      totalClaims: 1,
      totalVerified: 1,
      failedCount: 1,
      hasCritique: true,
      critique: 'Critique.',
      improvedPrompt: 'Prompt.',
    };
    const output = formatCritique(analysis, 'mock');
    expect(output).toContain('A'.repeat(80) + '...');
    expect(output).not.toContain('A'.repeat(81));
  });

  it('should NOT truncate claim text that is exactly 80 characters', () => {
    const exactText = 'B'.repeat(80);
    const analysis: CritiqueAnalysis = {
      failedClaims: [makeClaim({ id: 'c1', text: exactText })],
      totalClaims: 1,
      totalVerified: 1,
      failedCount: 1,
      hasCritique: true,
      critique: 'Critique.',
      improvedPrompt: 'Prompt.',
    };
    const output = formatCritique(analysis, 'mock');
    expect(output).toContain(exactText);
    expect(output).not.toContain(exactText + '...');
  });
});

// ---------------------------------------------------------------------------
// 11. formatCritique — no critique from provider
// ---------------------------------------------------------------------------

describe('formatCritique — no critique from provider', () => {
  it('should not show "CRITIQUE:" section when hasCritique is false', () => {
    const analysis: CritiqueAnalysis = {
      failedClaims: [makeClaim({ id: 'c1', text: 'Some failed claim' })],
      totalClaims: 2,
      totalVerified: 2,
      failedCount: 1,
      hasCritique: false,
      critique: '',
      improvedPrompt: '',
    };
    const output = formatCritique(analysis, 'mock');
    expect(output).not.toContain('CRITIQUE:');
  });

  it('should handle empty improvedPrompt gracefully when hasCritique is false', () => {
    const analysis: CritiqueAnalysis = {
      failedClaims: [makeClaim({ id: 'c1', text: 'Some failed claim' })],
      totalClaims: 2,
      totalVerified: 2,
      failedCount: 1,
      hasCritique: false,
      critique: '',
      improvedPrompt: '',
    };
    const output = formatCritique(analysis, 'mock');
    expect(output).not.toContain('IMPROVED PROMPT:');
    // Should still have the summary line
    expect(output).toContain('Summary:');
  });
});

// ---------------------------------------------------------------------------
// 12. formatCritique — structural details
// ---------------------------------------------------------------------------

describe('formatCritique — structural details', () => {
  it('should start with "Critique Analysis" title', () => {
    const analysis: CritiqueAnalysis = {
      failedClaims: [],
      totalClaims: 0,
      totalVerified: 0,
      failedCount: 0,
      hasCritique: false,
      critique: '',
      improvedPrompt: '',
    };
    const output = formatCritique(analysis, 'mock');
    const lines = output.split('\n');
    expect(lines[0]).toBe('Critique Analysis');
  });

  it('should have a separator of 17 U+2550 characters on second line', () => {
    const analysis: CritiqueAnalysis = {
      failedClaims: [],
      totalClaims: 0,
      totalVerified: 0,
      failedCount: 0,
      hasCritique: false,
      critique: '',
      improvedPrompt: '',
    };
    const output = formatCritique(analysis, 'mock');
    const lines = output.split('\n');
    expect(lines[1]).toBe('\u2550'.repeat(17));
  });

  it('should show provider name in the header line', () => {
    const analysis: CritiqueAnalysis = {
      failedClaims: [],
      totalClaims: 0,
      totalVerified: 0,
      failedCount: 0,
      hasCritique: false,
      critique: '',
      improvedPrompt: '',
    };
    const output = formatCritique(analysis, 'gemini-pro');
    expect(output).toContain('Provider: gemini-pro');
  });

  it('should format claim type and importance in bracket notation', () => {
    const analysis: CritiqueAnalysis = {
      failedClaims: [makeClaim({ id: 'c1', type: 'opinion', importance: 4, text: 'A claim' })],
      totalClaims: 1,
      totalVerified: 1,
      failedCount: 1,
      hasCritique: true,
      critique: 'Critique text.',
      improvedPrompt: 'Improved prompt.',
    };
    const output = formatCritique(analysis, 'mock');
    expect(output).toContain('[opinion] imp:4');
  });
});
