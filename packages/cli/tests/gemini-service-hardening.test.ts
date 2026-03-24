/**
 * Gemini Service + Rules Registry Hardening Tests (N-152) — GS1–GS8
 *
 * Covers uncovered branches in two modules:
 *   GS1–GS5 : services/geminiService.ts
 *              cleanJson() markdown code-block path (line 18)
 *              cleanJson() no-JSON fallback path (line 42)
 *              verifyClaim() JSON parse failure → response.text fallback (lines 155-159)
 *              verifyClaim() grounding chunks → sources array (line 167)
 *              extractClaims() early-return guards (line 53)
 *   GS6–GS8 : rules/registry.ts
 *              loadCustomYamlRules() loop body — loads and registers factories (lines 46-52)
 *              _resetYamlState() loop body — deletes loaded yamlFactories (lines 145-147)
 *              loadBuiltInYamlRules() idempotency guard (lines 26-27)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @google/genai before importing geminiService ─────────────────────────

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
  },
}));

import { extractClaims, verifyClaim } from '../services/geminiService.js';
import type { Claim } from '../types.js';
import {
  loadCustomYamlRules,
  loadBuiltInYamlRules,
  listRules,
  _resetYamlState,
  registerRule,
  unregisterRule,
} from '../rules/registry.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const YAML_DIR = resolve(__dir, '../rules/yaml');

const CLAIM: Claim = { id: 'c1', text: 'The Earth is flat.', type: 'fact', importance: 5 };

// ===========================================================================
// GS1–GS5 — services/geminiService.ts uncovered branches
// ===========================================================================

describe('geminiService.ts — cleanJson branches + verifyClaim fallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GS1: cleanJson extracts JSON from ```json code block (line 18)', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '```json\n{"status":"contradicted","explanation":"The Earth is spherical."}\n```',
      candidates: [],
    });

    const result = await verifyClaim(CLAIM, 'test-key');

    expect(result.status).toBe('contradicted');
    expect(result.explanation).toContain('spherical');
  });

  it('GS2: cleanJson fallback path when response has no JSON delimiters (line 42)', async () => {
    // Text with no { or [ → cleanJson strips ```json markers and trims → JSON.parse fails
    // → catch block fires → response.text used as explanation (status: mixed)
    mockGenerateContent.mockResolvedValue({
      text: 'plain prose with no JSON structure here',
      candidates: [],
    });

    const result = await verifyClaim(CLAIM, 'test-key');

    // JSON parse fails → fallback: status = 'mixed', explanation = text substring
    expect(result.status).toBe('mixed');
    expect(result.explanation).toContain('plain prose');
  });

  it('GS3: broken JSON triggers catch → response.text becomes explanation (lines 155-159)', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{status: contradicted, missing: quotes}',
      candidates: [],
    });

    const result = await verifyClaim(CLAIM, 'test-key');

    expect(result.status).toBe('mixed');
    // explanation is response.text.substring(0, 150) + '...'
    expect(result.explanation).toMatch(/contradicted/);
  });

  it('GS4: grounding chunks → sources array populated (line 167)', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '{"status":"supported","explanation":"Confirmed by sources."}',
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            { web: { title: 'NASA', uri: 'https://nasa.gov/earth' } },
            { web: { title: 'NOAA', uri: 'https://noaa.gov/ocean' } },
          ],
        },
      }],
    });

    const result = await verifyClaim(CLAIM, 'test-key');

    expect(result.status).toBe('supported');
    expect(result.sources).toHaveLength(2);
    expect(result.sources![0]!.title).toBe('NASA');
    expect(result.sources![1]!.title).toBe('NOAA');
  });

  it('GS5: extractClaims returns [] when both text and image are falsy (line 53)', async () => {
    const result = await extractClaims('', 'test-key');
    expect(result).toEqual([]);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// GS6–GS8 — rules/registry.ts uncovered branches
// ===========================================================================

describe('rules/registry.ts — YAML loader branches', () => {
  beforeEach(() => {
    _resetYamlState();
  });

  it('GS6: loadCustomYamlRules() loop body — registers factories from YAML dir (lines 46-52)', () => {
    // Use the built-in yaml/ dir which has bias.yaml, pii.yaml, security.yaml
    const count = loadCustomYamlRules(YAML_DIR);

    // At least 1 rule loaded — covers the for-loop body (lines 49-51)
    expect(count).toBeGreaterThanOrEqual(1);

    // Registered rules appear in listRules()
    const names = listRules();
    expect(names.length).toBeGreaterThan(0);

    // Cleanup
    for (const name of names) {
      unregisterRule(name);
    }
  });

  it('GS7: _resetYamlState() loop body deletes yamlFactories entries (lines 145-147)', () => {
    // Load YAML rules so yamlFactories is populated
    loadBuiltInYamlRules();

    // _resetYamlState() must iterate the yamlFactories map and delete each key
    // The loop body (lines 145-147) is only hit when there are entries to delete
    _resetYamlState();

    // After reset, loading again should re-populate (yamlLoaded === false)
    loadBuiltInYamlRules();
    const names = listRules();
    expect(names.length).toBeGreaterThan(0);
  });

  it('GS8: loadBuiltInYamlRules() idempotent — second call is a no-op (lines 26-27)', () => {
    loadBuiltInYamlRules(); // first call — sets yamlLoaded = true
    const countAfterFirst = listRules().length;

    loadBuiltInYamlRules(); // second call — early-return branch (line 26)
    const countAfterSecond = listRules().length;

    // Count must be identical — no duplicate registrations
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
