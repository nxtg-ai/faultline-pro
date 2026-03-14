import { describe, it, expect, afterEach } from 'vitest';
import {
  calibrate,
  getProfile,
  registerProfile,
  unregisterProfile,
  listProfiles,
  type CalibrationProfile,
} from '../compliance/calibration';

describe('Confidence Calibration: calibrate()', () => {
  describe('linear mapping (mock provider)', () => {
    it('should map 0.0 → 0', () => {
      expect(calibrate(0, 'mock')).toBe(0);
    });

    it('should map 1.0 → 100', () => {
      expect(calibrate(1.0, 'mock')).toBe(100);
    });

    it('should map 0.5 → 50', () => {
      expect(calibrate(0.5, 'mock')).toBe(50);
    });

    it('should map 0.25 → 25', () => {
      expect(calibrate(0.25, 'mock')).toBe(25);
    });

    it('should map 0.75 → 75', () => {
      expect(calibrate(0.75, 'mock')).toBe(75);
    });
  });

  describe('logarithmic mapping (gemini provider)', () => {
    it('should map 0.0 → 0', () => {
      expect(calibrate(0, 'gemini')).toBe(0);
    });

    it('should map 1.0 → 100', () => {
      expect(calibrate(1.0, 'gemini')).toBe(100);
    });

    it('should amplify low-range scores (0.1 maps above 10)', () => {
      const result = calibrate(0.1, 'gemini');
      // logarithmic curve: log1p(0.1*9)/log(10) ≈ 0.279 → 28
      expect(result).toBeGreaterThan(10);
    });

    it('should compress high-range scores (0.9 maps below 100)', () => {
      const result = calibrate(0.9, 'gemini');
      // logarithmic curve: log1p(0.9*9)/log(10) ≈ 0.946 → 95
      expect(result).toBeLessThan(100);
      expect(result).toBeGreaterThan(90);
    });

    it('should map 0.5 higher than linear (above 50)', () => {
      const result = calibrate(0.5, 'gemini');
      expect(result).toBeGreaterThan(50);
    });
  });

  describe('edge cases', () => {
    it('should clamp negative input to 0', () => {
      expect(calibrate(-0.5, 'mock')).toBe(0);
    });

    it('should clamp input above max to 100', () => {
      expect(calibrate(1.5, 'mock')).toBe(100);
    });

    it('should handle exactly 0', () => {
      expect(calibrate(0, 'mock')).toBe(0);
      expect(calibrate(0, 'gemini')).toBe(0);
    });

    it('should handle exactly 100 (mapped from 1.0)', () => {
      expect(calibrate(1.0, 'mock')).toBe(100);
      expect(calibrate(1.0, 'gemini')).toBe(100);
    });

    it('should return integer (no decimals)', () => {
      const result = calibrate(0.333, 'mock');
      expect(Number.isInteger(result)).toBe(true);
    });

    it('should fall back to linear 0-1 for unknown provider', () => {
      expect(calibrate(0.5, 'unknown-provider')).toBe(50);
      expect(calibrate(0, 'unknown-provider')).toBe(0);
      expect(calibrate(1, 'unknown-provider')).toBe(100);
    });
  });

  describe('out-of-range raw scores', () => {
    it('should clamp -100 to 0 for mock', () => {
      expect(calibrate(-100, 'mock')).toBe(0);
    });

    it('should clamp 999 to 100 for mock', () => {
      expect(calibrate(999, 'mock')).toBe(100);
    });

    it('should clamp -0.001 to 0 for gemini', () => {
      expect(calibrate(-0.001, 'gemini')).toBe(0);
    });

    it('should clamp 1.001 to 100 for gemini', () => {
      expect(calibrate(1.001, 'gemini')).toBe(100);
    });
  });
});

describe('Calibration Profiles', () => {
  describe('built-in profiles', () => {
    it('should have mock profile', () => {
      const profile = getProfile('mock');
      expect(profile).toBeDefined();
      expect(profile!.provider).toBe('mock');
      expect(profile!.curve).toBe('linear');
    });

    it('should have gemini profile', () => {
      const profile = getProfile('gemini');
      expect(profile).toBeDefined();
      expect(profile!.provider).toBe('gemini');
      expect(profile!.curve).toBe('logarithmic');
    });

    it('should have claude profile', () => {
      const profile = getProfile('claude');
      expect(profile).toBeDefined();
      expect(profile!.provider).toBe('claude');
      expect(profile!.curve).toBe('logarithmic');
    });

    it('should return undefined for unknown provider', () => {
      expect(getProfile('nonexistent')).toBeUndefined();
    });

    it('should list all built-in profiles', () => {
      const names = listProfiles();
      expect(names).toContain('mock');
      expect(names).toContain('gemini');
      expect(names).toContain('claude');
    });
  });

  describe('custom profiles', () => {
    const customProfile: CalibrationProfile = {
      provider: 'custom-llm',
      rawMin: 0,
      rawMax: 10,
      curve: 'linear',
    };

    afterEach(() => {
      unregisterProfile('custom-llm');
    });

    it('should register a custom profile', () => {
      registerProfile(customProfile);
      expect(getProfile('custom-llm')).toEqual(customProfile);
    });

    it('should calibrate using custom profile range', () => {
      registerProfile(customProfile);
      // rawMin=0, rawMax=10, linear: 5 → 50
      expect(calibrate(5, 'custom-llm')).toBe(50);
      expect(calibrate(0, 'custom-llm')).toBe(0);
      expect(calibrate(10, 'custom-llm')).toBe(100);
    });

    it('should clamp to custom range', () => {
      registerProfile(customProfile);
      expect(calibrate(-5, 'custom-llm')).toBe(0);
      expect(calibrate(15, 'custom-llm')).toBe(100);
    });

    it('should unregister a custom profile', () => {
      registerProfile(customProfile);
      unregisterProfile('custom-llm');
      expect(getProfile('custom-llm')).toBeUndefined();
    });

    it('should override a built-in profile', () => {
      const overrideGemini: CalibrationProfile = {
        provider: 'gemini',
        rawMin: 0,
        rawMax: 100,
        curve: 'linear',
      };
      const original = getProfile('gemini')!;
      registerProfile(overrideGemini);
      expect(calibrate(50, 'gemini')).toBe(50);
      // Restore
      registerProfile(original);
    });

    it('should handle equal rawMin and rawMax', () => {
      const flat: CalibrationProfile = {
        provider: 'flat-provider',
        rawMin: 5,
        rawMax: 5,
        curve: 'linear',
      };
      registerProfile(flat);
      expect(calibrate(5, 'flat-provider')).toBe(100);
      expect(calibrate(4, 'flat-provider')).toBe(0);
      unregisterProfile('flat-provider');
    });

    it('should support logarithmic custom profile', () => {
      const logProfile: CalibrationProfile = {
        provider: 'log-custom',
        rawMin: 0,
        rawMax: 100,
        curve: 'logarithmic',
      };
      registerProfile(logProfile);
      // 50 on a log scale should map above 50
      const result = calibrate(50, 'log-custom');
      expect(result).toBeGreaterThan(50);
      expect(result).toBeLessThanOrEqual(100);
      unregisterProfile('log-custom');
    });
  });
});
