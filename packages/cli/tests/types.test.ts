import { describe, it, expect } from 'vitest';
import type { Claim, ClaimType, ClaimStatus, VerificationResult, AnalysisState } from '../types';

describe('types.ts — Type Definitions', () => {
  describe('Claim interface', () => {
    it('should accept a valid fact claim', () => {
      const claim: Claim = {
        id: 'c1',
        text: 'The Earth orbits the Sun.',
        type: 'fact',
        importance: 5,
      };
      expect(claim.id).toBe('c1');
      expect(claim.type).toBe('fact');
      expect(claim.importance).toBe(5);
    });

    it('should accept an opinion claim', () => {
      const claim: Claim = {
        id: 'c2',
        text: 'Pizza is the best food.',
        type: 'opinion',
        importance: 2,
      };
      expect(claim.type).toBe('opinion');
    });

    it('should accept an interpretation claim', () => {
      const claim: Claim = {
        id: 'c3',
        text: 'The data suggests economic growth.',
        type: 'interpretation',
        importance: 4,
      };
      expect(claim.type).toBe('interpretation');
    });

    it('should support importance range 1-5', () => {
      const claims: Claim[] = [1, 2, 3, 4, 5].map((imp) => ({
        id: `c${imp}`,
        text: `Claim ${imp}`,
        type: 'fact' as ClaimType,
        importance: imp,
      }));
      expect(claims).toHaveLength(5);
      expect(claims[0].importance).toBe(1);
      expect(claims[4].importance).toBe(5);
    });
  });

  describe('ClaimStatus type', () => {
    it('should cover all valid statuses', () => {
      const statuses: ClaimStatus[] = ['supported', 'contradicted', 'mixed', 'unverified', 'loading', 'skipped'];
      expect(statuses).toHaveLength(6);
    });
  });

  describe('VerificationResult interface', () => {
    it('should accept a supported result with sources', () => {
      const result: VerificationResult = {
        claimId: 'c1',
        status: 'supported',
        explanation: 'Evidence confirms the claim.',
        sources: [{ title: 'NASA', uri: 'https://nasa.gov' }],
      };
      expect(result.status).toBe('supported');
      expect(result.sources).toHaveLength(1);
    });

    it('should accept a result with empty sources', () => {
      const result: VerificationResult = {
        claimId: 'c2',
        status: 'unverified',
        explanation: 'No evidence found.',
        sources: [],
      };
      expect(result.sources).toHaveLength(0);
    });
  });

  describe('AnalysisState interface', () => {
    it('should represent idle state', () => {
      const state: AnalysisState = {
        claims: [],
        verifications: {},
        isProcessing: false,
        progressMessage: '',
        step: 'idle',
        overallRisk: 'low',
      };
      expect(state.step).toBe('idle');
      expect(state.isProcessing).toBe(false);
    });

    it('should represent active processing state', () => {
      const state: AnalysisState = {
        claims: [{ id: 'c1', text: 'Test', type: 'fact', importance: 3 }],
        verifications: {},
        isProcessing: true,
        progressMessage: 'Extracting...',
        step: 'extracting',
        overallRisk: 'low',
      };
      expect(state.isProcessing).toBe(true);
      expect(state.step).toBe('extracting');
    });

    it('should represent complete state with critique', () => {
      const state: AnalysisState = {
        claims: [],
        verifications: {},
        isProcessing: false,
        progressMessage: '',
        step: 'complete',
        overallRisk: 'high',
        critique: 'Structural weaknesses detected.',
        improvedPrompt: 'Ask with sources.',
      };
      expect(state.critique).toBeDefined();
      expect(state.improvedPrompt).toBeDefined();
    });

    it('should cover all step values', () => {
      const steps: AnalysisState['step'][] = ['idle', 'extracting', 'verifying', 'complete'];
      expect(steps).toHaveLength(4);
    });

    it('should cover all risk levels', () => {
      const risks: AnalysisState['overallRisk'][] = ['low', 'medium', 'high', 'critical'];
      expect(risks).toHaveLength(4);
    });
  });
});
