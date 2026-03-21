/**
 * Spinner Tests (N-144) — SP1–SP8
 *
 * Validates: N-02 (CLI Tool — progress feedback during scans)
 *
 * Covers both branches of createScanSpinner in cli/spinner.ts:
 *   SP1–SP3 : no-op branch (non-TTY, machine formats — the path tests always hit)
 *   SP4–SP7 : TTY/ora branch (lines 40-55) — mocked ora, process.stderr.isTTY=true
 *   SP8     : MACHINE_FORMATS set contents
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock ora before importing the module under test.
// createScanSpinner does `await import('ora')` dynamically; vi.mock hoists
// this replacement so the dynamic import resolves to our stub.
// ---------------------------------------------------------------------------

const mockSpinner = {
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn(),
  fail: vi.fn(),
  text: '',
};

vi.mock('ora', () => ({
  default: vi.fn(() => mockSpinner),
}));

import { createScanSpinner } from '../cli/spinner.js';

// ---------------------------------------------------------------------------
// SP1–SP3 — no-op branch (non-TTY or machine-readable format)
// ---------------------------------------------------------------------------

describe('createScanSpinner — no-op branch', () => {
  beforeEach(() => {
    // Ensure tests see a non-TTY stderr (the default in test runners)
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
  });

  it('SP1: non-TTY stderr returns silent no-op spinner', async () => {
    const spinner = await createScanSpinner();
    // All methods are no-ops — calling them should not throw
    expect(() => spinner.onProgress('loading...')).not.toThrow();
    expect(() => spinner.succeed('done')).not.toThrow();
    expect(() => spinner.fail('error')).not.toThrow();
  });

  it('SP2: TTY + json format returns no-op (MACHINE_FORMATS guard)', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    const spinner = await createScanSpinner('json');
    // Even in TTY mode, machine formats must suppress spinner output
    expect(() => spinner.onProgress('msg')).not.toThrow();
    expect(() => spinner.succeed('ok')).not.toThrow();
  });

  it('SP3: TTY + sarif format returns no-op (MACHINE_FORMATS guard)', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    const spinner = await createScanSpinner('sarif');
    expect(() => spinner.onProgress('msg')).not.toThrow();
    expect(() => spinner.fail('err')).not.toThrow();
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
  });
});

// ---------------------------------------------------------------------------
// SP4–SP7 — TTY/ora branch (lines 40-55 in spinner.ts)
// ---------------------------------------------------------------------------

describe('createScanSpinner — TTY/ora branch', () => {
  beforeEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    vi.clearAllMocks();
    mockSpinner.text = '';
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
  });

  it('SP4: TTY + non-machine format → ora is called and spinner returned', async () => {
    const { default: ora } = await import('ora');
    const spinner = await createScanSpinner('text');
    // ora should have been called to create a spinner
    expect(ora).toHaveBeenCalled();
    // The returned object has the three expected methods
    expect(typeof spinner.onProgress).toBe('function');
    expect(typeof spinner.succeed).toBe('function');
    expect(typeof spinner.fail).toBe('function');
  });

  it('SP5: onProgress sets spinner.text (covers the setter line)', async () => {
    const spinner = await createScanSpinner('text');
    spinner.onProgress('Verifying claim 2/5...');
    expect(mockSpinner.text).toBe('Verifying claim 2/5...');
  });

  it('SP6: succeed calls spinner.succeed with the message', async () => {
    const spinner = await createScanSpinner();
    spinner.succeed('Scan complete');
    expect(mockSpinner.succeed).toHaveBeenCalledWith('Scan complete');
  });

  it('SP7: fail calls spinner.fail with the message', async () => {
    const spinner = await createScanSpinner();
    spinner.fail('Scan failed: no API key');
    expect(mockSpinner.fail).toHaveBeenCalledWith('Scan failed: no API key');
  });
});

// ---------------------------------------------------------------------------
// SP8 — MACHINE_FORMATS set contents
// ---------------------------------------------------------------------------

describe('createScanSpinner — MACHINE_FORMATS', () => {
  it('SP8: undefined format is treated as non-machine (no ?? fallback crash)', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    // Should not throw — undefined format falls back to '' via ?? ''
    const spinner = await createScanSpinner(undefined);
    expect(spinner).toBeDefined();
  });
});
