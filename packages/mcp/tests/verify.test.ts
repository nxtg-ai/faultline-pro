import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyClaims, autoDetectProvider, isGrounded } from '../src/verify.js';
import type { ScanResult } from '@nxtg/faultline/cli/scan.js';

/** Build a ScanResult the way the engine does, for mapping tests. */
function scanResult(over: Partial<ScanResult> = {}): ScanResult {
  return {
    input: 'text',
    provider: 'mock',
    claims: [
      { id: 'c1', text: 'Claim one', type: 'fact', importance: 5 },
      { id: 'c2', text: 'Claim two', type: 'fact', importance: 3 },
    ],
    verifications: {
      c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] },
      c2: { claimId: 'c2', status: 'contradicted', explanation: 'no', sources: [] },
    },
    overallRisk: 'medium',
    complianceReport: {} as ScanResult['complianceReport'],
    ruleFindings: [],
    verificationErrors: 0,
    degraded: false,
    ...over,
  };
}

let auditRoot: string;

beforeEach(() => {
  auditRoot = mkdtempSync(join(tmpdir(), 'fl-mcp-'));
  process.env.FAULTLINE_HISTORY_DIR = auditRoot;
  delete process.env.FAULTLINE_MCP_NO_HISTORY;
});

afterEach(() => {
  rmSync(auditRoot, { recursive: true, force: true });
  delete process.env.FAULTLINE_HISTORY_DIR;
  delete process.env.FAULTLINE_MCP_NO_HISTORY;
});

describe('verifyClaims — input handling', () => {
  it('rejects empty text rather than scanning nothing', async () => {
    await expect(verifyClaims({ text: '   ' }, { scanFn: async () => scanResult() })).rejects.toThrow(
      /non-empty/i,
    );
  });
});

describe('verifyClaims — mapping', () => {
  it('maps each claim to its verdict', async () => {
    const out = await verifyClaims({ text: 'x' }, { scanFn: async () => scanResult() });
    expect(out.claims.map((c) => c.verdict)).toEqual(['VERIFIED', 'REFUTED']);
    expect(out.claims_total).toBe(2);
    expect(out.degraded).toBe(false);
  });

  it('orders claims most-important-first', async () => {
    const out = await verifyClaims(
      { text: 'x' },
      {
        scanFn: async () =>
          scanResult({
            claims: [
              { id: 'c1', text: 'minor', type: 'fact', importance: 1 },
              { id: 'c2', text: 'major', type: 'fact', importance: 5 },
            ],
          }),
      },
    );
    expect(out.claims[0].claim).toBe('major');
  });

  it('truncates to max_claims but reports the true total', async () => {
    const out = await verifyClaims({ text: 'x', max_claims: 1 }, { scanFn: async () => scanResult() });
    expect(out.claims).toHaveLength(1);
    expect(out.claims_total).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it('does not mark truncated when max_claims exceeds the claim count', async () => {
    const out = await verifyClaims({ text: 'x', max_claims: 99 }, { scanFn: async () => scanResult() });
    expect(out.truncated).toBe(false);
  });
});

describe('verifyClaims — degradation signal', () => {
  it('reports degraded when the engine flags it', async () => {
    const out = await verifyClaims({ text: 'x' }, { scanFn: async () =>
      scanResult({
        verifications: {
          c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] },
          c2: {
            claimId: 'c2',
            status: 'unverified',
            explanation: 'quota',
            sources: [],
            apiError: true,
          },
        },
        verificationErrors: 1,
        degraded: true,
      }) },
    );
    expect(out.degraded).toBe(true);
    expect(out.unchecked_count).toBe(1);
    expect(out.summary).toMatch(/DEGRADED/);
    expect(out.summary).toMatch(/not a clean bill of health/i);
  });

  it('counts unchecked claims across ALL claims, not just the truncated page', async () => {
    // The critical property: narrowing the view with max_claims must not hide
    // that other claims went unchecked. A caller trusting a truncated, clean-
    // looking page would ship unverified assertions.
    const out = await verifyClaims({ text: 'x', max_claims: 1 }, { scanFn: async () =>
      scanResult({
        verifications: {
          c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] },
          c2: {
            claimId: 'c2',
            status: 'unverified',
            explanation: 'quota',
            sources: [],
            apiError: true,
          },
        },
        verificationErrors: 1,
        degraded: true,
      }) },
    );
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].verdict).toBe('VERIFIED');
    expect(out.unchecked_count).toBe(1);
    expect(out.degraded).toBe(true);
  });

  it('treats a missing verification record as degradation', async () => {
    const out = await verifyClaims({ text: 'x' }, { scanFn: async () =>
      scanResult({ verifications: {}, degraded: false, verificationErrors: 0 }) },
    );
    expect(out.degraded).toBe(true);
    expect(out.unchecked_count).toBe(2);
  });
});

describe('verifyClaims — audit evidence', () => {
  it('writes a real audit record and returns a ref that resolves to it', async () => {
    const out = await verifyClaims({ text: 'x' }, { scanFn: async () => scanResult() });
    expect(out.audit_ref).toMatch(/^fl_[0-9a-f]{16}$/);
    expect(out.audit_path).toBeDefined();
    expect(existsSync(out.audit_path!)).toBe(true);

    const record = JSON.parse(readFileSync(out.audit_path!, 'utf-8'));
    expect(record.id).toBe(out.audit_ref);
    expect(record.source).toBe('mcp:verify_claims');
    expect(record.scanResult.claims).toHaveLength(2);
  });

  it('omits audit_ref rather than returning a dangling id when persistence is off', async () => {
    process.env.FAULTLINE_MCP_NO_HISTORY = '1';
    const out = await verifyClaims({ text: 'x' }, { scanFn: async () => scanResult() });
    expect(out.audit_ref).toBeUndefined();
    expect(out.audit_skipped).toMatch(/FAULTLINE_MCP_NO_HISTORY/);
  });
});

describe('grounding — verdicts without evidence must not read as evidence', () => {
  it('recognises gemini as grounded in both flag and display form', () => {
    expect(isGrounded('gemini')).toBe(true);
    expect(isGrounded('Google Gemini')).toBe(true);
  });

  it('does not claim grounding for providers that judge from model knowledge', () => {
    for (const p of ['openai', 'OpenAI', 'claude', 'perplexity', 'mock']) {
      expect(isGrounded(p)).toBe(false);
    }
  });

  it('treats an unnamed provider as grounded — both transports default to gemini', () => {
    expect(isGrounded()).toBe(true);
    expect(isGrounded('')).toBe(true);
  });

  it('flags an ungrounded scan loudly in the summary', async () => {
    const out = await verifyClaims({ text: 'x', provider: 'openai' }, { scanFn: async () =>
      scanResult({ provider: 'OpenAI' }) },
    );
    expect(out.grounded).toBe(false);
    expect(out.summary).toMatch(/NOT GROUNDED/);
    expect(out.summary).toMatch(/no evidence/i);
  });

  it('counts real verdicts that carry no source URL', async () => {
    const out = await verifyClaims({ text: 'x', provider: 'gemini' }, { scanFn: async () =>
      scanResult({ provider: 'Google Gemini' }) },
    );
    // Both fixture verdicts are real (VERIFIED, REFUTED) with empty sources.
    expect(out.grounded).toBe(true);
    expect(out.unsourced_count).toBe(2);
    expect(out.summary).toMatch(/no supporting source URL/);
  });

  it('does not count UNCHECKED claims as unsourced verdicts', async () => {
    const out = await verifyClaims({ text: 'x', provider: 'gemini' }, { scanFn: async () =>
      scanResult({
        verifications: {
          c1: {
            claimId: 'c1',
            status: 'supported',
            explanation: 'ok',
            sources: [{ title: 'S', uri: 'https://s.example' }],
          },
          c2: {
            claimId: 'c2',
            status: 'unverified',
            explanation: 'quota',
            sources: [],
            apiError: true,
          },
        },
        degraded: true,
        verificationErrors: 1,
      }) },
    );
    expect(out.unsourced_count).toBe(0);
  });
});

describe('risk_score — no reading without evidence', () => {
  it('returns null when not one claim received a real verdict', async () => {
    // Reproduces the live invalid-key run: the engine bands a fully-degraded
    // scan as "low" because nothing was contradicted. Emitting that number
    // would report "safe" on the basis of nothing having been checked.
    const out = await verifyClaims({ text: 'x' }, { scanFn: async () =>
      scanResult({
        overallRisk: 'low',
        verifications: {
          c1: { claimId: 'c1', status: 'unverified', explanation: 'e', sources: [], apiError: true },
          c2: { claimId: 'c2', status: 'unverified', explanation: 'e', sources: [], apiError: true },
        },
        verificationErrors: 2,
        degraded: true,
      }) },
    );
    expect(out.risk_score).toBeNull();
    expect(out.summary).toMatch(/risk UNKNOWN/);
    expect(out.summary).not.toMatch(/risk LOW/);
  });

  it('still reports a score when at least one claim was really checked', async () => {
    const out = await verifyClaims({ text: 'x' }, { scanFn: async () =>
      scanResult({
        overallRisk: 'high',
        verifications: {
          c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] },
          c2: { claimId: 'c2', status: 'unverified', explanation: 'e', sources: [], apiError: true },
        },
        verificationErrors: 1,
        degraded: true,
      }) },
    );
    expect(out.risk_score).toBe(75);
    expect(out.degraded).toBe(true);
  });

  it('treats an all-skipped scan as having no risk reading', async () => {
    const out = await verifyClaims({ text: 'x' }, { scanFn: async () =>
      scanResult({
        overallRisk: 'low',
        verifications: {
          c1: { claimId: 'c1', status: 'skipped', explanation: 'opinion', sources: [] },
          c2: { claimId: 'c2', status: 'skipped', explanation: 'opinion', sources: [] },
        },
      }) },
    );
    expect(out.risk_score).toBeNull();
  });
});

describe('transport mode', () => {
  /** A fetch stub that records the request and returns a scan result. */
  function stubFetch(result = scanResult({ provider: 'Google Gemini' })) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return {
        ok: true,
        status: 200,
        json: async () => result,
        text: async () => '',
      };
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('reports local mode and does not touch the network', async () => {
    const { impl, calls } = stubFetch();
    const out = await verifyClaims(
      { text: 'x', provider: 'gemini' },
      { scanFn: async () => scanResult(), fetchImpl: impl, transport: { mode: 'local' } },
    );
    expect(out.mode).toBe('local');
    expect(calls).toHaveLength(0);
  });

  it('reports hosted mode and posts to the API', async () => {
    const { impl, calls } = stubFetch();
    const out = await verifyClaims(
      { text: 'check this' },
      {
        fetchImpl: impl,
        transport: { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'k' },
      },
    );
    expect(out.mode).toBe('hosted');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://x.test/scan');
  });

  it('omits the provider in hosted mode so the server default applies', async () => {
    // Hosted holds server-side provider keys; forcing a local autodetect here
    // would send 'mock' to a server perfectly able to run grounded gemini.
    const { impl, calls } = stubFetch();
    await verifyClaims(
      { text: 'x' },
      { fetchImpl: impl, transport: { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'k' } },
    );
    expect(calls[0].body).toEqual({ text: 'x' });
  });

  it('still honours an explicitly requested provider in hosted mode', async () => {
    const { impl, calls } = stubFetch();
    await verifyClaims(
      { text: 'x', provider: 'claude' },
      { fetchImpl: impl, transport: { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'k' } },
    );
    expect(calls[0].body).toEqual({ text: 'x', provider: 'claude' });
  });

  it('surfaces a hosted rejection as an error, never as a clean result', async () => {
    const impl = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '{"error":"Unauthorized"}',
    })) as unknown as typeof fetch;

    await expect(
      verifyClaims(
        { text: 'x' },
        { fetchImpl: impl, transport: { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'bad' } },
      ),
    ).rejects.toThrow(/401/);
  });
});

describe('autoDetectProvider', () => {
  it('honours an explicit FAULTLINE_PROVIDER first', () => {
    expect(autoDetectProvider({ FAULTLINE_PROVIDER: 'claude', GEMINI_API_KEY: 'k' })).toBe('claude');
  });

  it('follows the CLI precedence order', () => {
    expect(autoDetectProvider({ GEMINI_API_KEY: 'k', OPENAI_API_KEY: 'k' })).toBe('gemini');
    expect(autoDetectProvider({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' })).toBe('openai');
    expect(autoDetectProvider({ ANTHROPIC_API_KEY: 'k' })).toBe('claude');
    expect(autoDetectProvider({ PERPLEXITY_API_KEY: 'k' })).toBe('perplexity');
  });

  it('falls back to mock when no key is present', () => {
    expect(autoDetectProvider({})).toBe('mock');
  });
});
