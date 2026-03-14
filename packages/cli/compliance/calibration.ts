/**
 * Confidence score calibration module.
 *
 * Different LLM providers return confidence signals on different scales.
 * This module normalizes raw provider scores to a consistent 0-100 scale
 * for uniform severity assessment across providers.
 */

export type MappingCurve = 'linear' | 'logarithmic';

export interface CalibrationProfile {
  /** Provider name (must match registry key). */
  provider: string;
  /** Minimum expected raw score from this provider. */
  rawMin: number;
  /** Maximum expected raw score from this provider. */
  rawMax: number;
  /** Mapping curve used for normalization. */
  curve: MappingCurve;
}

/**
 * Built-in calibration profiles keyed by provider name.
 * Add new profiles as providers are registered.
 */
const profiles: Record<string, CalibrationProfile> = {
  mock: {
    provider: 'mock',
    rawMin: 0,
    rawMax: 1,
    curve: 'linear',
  },
  gemini: {
    provider: 'gemini',
    rawMin: 0,
    rawMax: 1,
    curve: 'logarithmic',
  },
  claude: {
    provider: 'claude',
    rawMin: 0,
    rawMax: 1,
    curve: 'logarithmic',
  },
};

/**
 * Normalize a raw confidence score to the 0-100 scale using
 * the provider's calibration profile.
 *
 * - Clamps input to [rawMin, rawMax] before mapping.
 * - Linear: straight proportional mapping.
 * - Logarithmic: amplifies differences in the low-confidence range
 *   (small raw differences near 0 are more meaningful).
 *
 * @returns Integer 0-100 (rounded).
 */
export function calibrate(rawScore: number, providerName: string): number {
  const profile = profiles[providerName];
  if (!profile) {
    // Unknown provider — fall back to identity linear mapping on 0-1
    return clampAndRound(rawScore, 0, 1, 'linear');
  }
  return clampAndRound(rawScore, profile.rawMin, profile.rawMax, profile.curve);
}

function clampAndRound(
  raw: number,
  min: number,
  max: number,
  curve: MappingCurve,
): number {
  if (max === min) return raw >= max ? 100 : 0;

  // Clamp to valid range
  const clamped = Math.max(min, Math.min(max, raw));

  // Normalize to 0-1
  const normalized = (clamped - min) / (max - min);

  // Apply curve
  let mapped: number;
  if (curve === 'logarithmic') {
    // log1p(x * 9) / log(10) maps [0,1] → [0,1] with logarithmic curve
    mapped = Math.log1p(normalized * 9) / Math.log(10);
  } else {
    mapped = normalized;
  }

  // Scale to 0-100 and round
  return Math.round(mapped * 100);
}

/**
 * Get the calibration profile for a provider.
 * Returns undefined if no profile is registered.
 */
export function getProfile(providerName: string): CalibrationProfile | undefined {
  return profiles[providerName];
}

/**
 * Register or override a calibration profile.
 */
export function registerProfile(profile: CalibrationProfile): void {
  profiles[profile.provider] = profile;
}

/**
 * Remove a custom calibration profile.
 * Built-in profiles can be re-added via registerProfile.
 */
export function unregisterProfile(providerName: string): void {
  delete profiles[providerName];
}

/**
 * List all registered profile provider names.
 */
export function listProfiles(): string[] {
  return Object.keys(profiles);
}
