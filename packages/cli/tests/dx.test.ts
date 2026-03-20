import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../cli/index.js';

// Isolated temp dir so init tests don't pollute /tmp and break config.test.ts
let initTmpDir: string;
function freshTmpDir(): string {
  initTmpDir = mkdtempSync(join(tmpdir(), 'faultline-init-'));
  return initTmpDir;
}

// Mock scan so tests don't make real API calls
vi.mock('../cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'demo text',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'Test claim.', type: 'fact', importance: 3 }],
    verifications: { c1: { claimId: 'c1', status: 'verified', explanation: 'OK', sources: [] } },
    overallRisk: 'low',
    complianceReport: {
      generatedAt: '2026-03-19T00:00:00.000Z',
      overallRiskLevel: 'low',
      euRiskSummary: {
        unacceptable: 0,
        high: 0,
        limited: 0,
        minimal: 1,
        totalClaims: 1,
        highestTier: 'minimal',
      },
      claimMappings: [],
      triggeredArticles: [],
      mitigations: [],
      riskTier: 'minimal',
      findings: [],
    },
    ruleFindings: [],
  }),
  batchScan: vi.fn(),
}));

describe('D-125: Provider auto-detection', () => {
  beforeEach(() => {
    // Clear all provider env vars
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
  });

  it('DX1. no env vars + explicit mock provider → scan fails on file-not-found, not provider', async () => {
    const result = await main(['scan', '--input', 'nonexistent.txt', '--provider', 'mock']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('not found');
  });

  it('DX2. GEMINI_API_KEY set → no --provider flag still resolves provider (no "No API key" error)', async () => {
    process.env.GEMINI_API_KEY = 'fake-key';
    const result = await main(['scan', '--input', 'nonexistent.txt']);
    expect(result.output).not.toContain('No API key found');
    delete process.env.GEMINI_API_KEY;
  });

  it('DX3. explicit --provider gemini with no API key → helpful error with env var name', async () => {
    // Use package.json as a file that always exists so the flow reaches the API key check
    const result = await main(['scan', '--input', 'package.json', '--provider', 'gemini']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('No API key');
    expect(result.output).toContain('GEMINI_API_KEY');
  });
});

describe('D-126: faultline demo', () => {
  it('DX4. faultline demo runs without API key and returns output', async () => {
    const result = await main(['demo']);
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('DX5. faultline demo output contains risk level', async () => {
    const result = await main(['demo']);
    expect(result.output).toMatch(/risk|claim|Faultline/i);
  });
});

describe('D-126: faultline init enhanced', () => {
  afterEach(() => {
    if (initTmpDir && existsSync(initTmpDir)) rmSync(initTmpDir, { recursive: true, force: true });
  });

  it('DX6. faultline init returns path + provider status + next steps', async () => {
    delete process.env.GEMINI_API_KEY;
    const result = await main(['init', '--dir', freshTmpDir()]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('initialized');
    expect(result.output).toContain('Next steps');
  });

  it('DX7. faultline init with GEMINI_API_KEY set shows gemini as configured', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const result = await main(['init', '--dir', freshTmpDir()]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('gemini');
    delete process.env.GEMINI_API_KEY;
  });

  it('DX8. faultline demo tip appears in init output', async () => {
    const result = await main(['init', '--dir', freshTmpDir()]);
    expect(result.output).toContain('demo');
  });
});
