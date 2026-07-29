/**
 * The first-run integrity guarantee.
 *
 * The mock provider returns `supported` for EVERY claim
 * (providers/mock_provider.ts:29). Before this was fixed, a user who installed
 * the CLI and ran it with no API key fell back to mock implicitly, and got:
 *
 *   [OK] VERIFIED    Chocolate cures cancer and the Earth is flat
 *        Mock verification: supported.
 *   Overall Risk: LOW
 *
 * A fabricated verdict, delivered confidently, on someone's first contact with
 * a tool whose entire purpose is catching fabricated confidence. These tests
 * exist so that can never ship again.
 *
 * The distinction being protected is IMPLICIT vs EXPLICIT mock:
 *   - implicit (no key, no --provider) → refuse, never invent a verdict
 *   - explicit (--provider mock)       → still works; it is the documented
 *                                        keyless CI path, and faultline-action
 *                                        depends on it
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/index';

const PROVIDER_KEYS = [
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'PERPLEXITY_API_KEY',
  'FAULTLINE_API_KEY',
  'FAULTLINE_PROVIDER',
  'FAULTLINE_API_URL',
];

let saved: Record<string, string | undefined>;
let dir: string;
let file: string;

beforeEach(() => {
  saved = {};
  for (const k of PROVIDER_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'fl-nokey-'));
  file = join(dir, 'input.txt');
  writeFileSync(file, 'Chocolate cures cancer and the Earth is flat.\n', 'utf-8');
});

afterEach(() => {
  for (const k of PROVIDER_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('scan with no provider key', () => {
  it('refuses rather than reporting a fabricated verdict', async () => {
    const result = await main(['scan', '--input', file]);

    expect(result.output).toMatch(/NOTHING WAS CHECKED/);
    expect(result.exitCode).toBe(1);
  });

  it('never claims a scan it did not run was supported, verified, or low risk', async () => {
    const { output } = await main(['scan', '--input', file]);

    expect(output).not.toMatch(/\bsupported\b/i);
    expect(output).not.toMatch(/\bVERIFIED\b/);
    expect(output).not.toMatch(/Overall Risk/i);
  });

  it('tells the user how to fix it', async () => {
    const { output } = await main(['scan', '--input', file]);

    expect(output).toContain('https://aistudio.google.com/apikey');
    expect(output).toContain('GEMINI_API_KEY');
    expect(output).toContain('FAULTLINE_API_KEY');
  });

  it('still runs when mock is asked for explicitly — the keyless CI path', async () => {
    const result = await main(['scan', '--input', file, '--provider', 'mock']);

    expect(result.output).not.toMatch(/NOTHING WAS CHECKED/);
    expect(result.exitCode).toBe(0);
  });
});

describe('guard with no provider key', () => {
  // guard reads stdin; main() is exercised through the same no-key branch,
  // which short-circuits before stdin is consumed.
  it('refuses rather than reporting a fabricated verdict', async () => {
    const result = await main(['guard']);

    expect(result.output).toMatch(/NOTHING WAS CHECKED/);
    expect(result.output).not.toMatch(/\bVERIFIED\b/);
    expect(result.output).not.toMatch(/Overall Risk/i);
  });

  it('is advisory without a gate — exit 0, but says nothing was checked', async () => {
    const result = await main(['guard']);
    expect(result.exitCode).toBe(0);
  });

  it('FAILS CLOSED under --fail-on, because unchecked is not passed', async () => {
    const result = await main(['guard', '--fail-on', 'refuted']);

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/NOTHING WAS CHECKED/);
  });

  it('points at a free key', async () => {
    const { output } = await main(['guard']);
    expect(output).toContain('https://aistudio.google.com/apikey');
  });
});

describe('the fabrication itself', () => {
  it('mock still reports every claim supported — which is why implicit mock is refused', async () => {
    // Guards the premise. If mock ever stops blanket-approving, this test fails
    // and the reasoning above should be revisited rather than silently kept.
    const result = await main(['scan', '--input', file, '--provider', 'mock']);
    expect(result.output.toLowerCase()).toMatch(/supported/);
  });
});
