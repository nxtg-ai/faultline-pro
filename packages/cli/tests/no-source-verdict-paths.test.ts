/**
 * No definite verdict without a source, on every provider and every path.
 *
 * A verified-claims product must never show supported, contradicted or mixed
 * without at least one source the reader can open. abstainWithoutSource (in
 * lib/verdict-guard.ts) applies the rule; this file checks that every place a
 * single-provider verdict leaves the engine passes through it:
 * - statically: every call to a provider's verifyClaim, parsed with the
 *   TypeScript compiler, is pinned by file and enclosing function, and each
 *   pinned call site has a behavioural test;
 * - by behaviour: OpenAI, Claude, Perplexity, a plugin provider and the mock
 *   provider, through the runner and through scan(), verifyFullScan() and
 *   batchScan() (the paths the API's scan, stream, deep, batch, report, full
 *   scan routes and the MCP server call).
 * The Gemini service applies the rule itself (tests/abstain-unverified.test.ts);
 * the admin verify route is checked in packages/api/tests/admin-verify-claims.test.ts.
 */
// Validates: no definite verdict without a source, on every provider and path
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { runVerification } from '../cli/verify-runner.js';
import { scan, verifyFullScan, batchScan } from '../cli/scan.js';
import { registerProvider } from '../providers/registry.js';
import { createOpenAIProvider } from '../providers/openai_provider.js';
import { createClaudeProvider } from '../providers/claude_provider.js';
import { createPerplexityProvider } from '../providers/perplexity_provider.js';
import { createMockProvider } from '../providers/mock_provider.js';
import { consensusVerify } from '../consensus/consensus_engine.js';
import { NO_SOURCE_EXPLANATION, abstainWithoutSource, billableVerdictCount, isBillableVerdict } from '../lib/verdict-guard.js';
import type { LLMProvider } from '../providers/base_provider.js';
import type { Claim, ProviderVote, Source, VerificationResult } from '../types.js';

const REPO = resolve(__dirname, '../../..');
const DEFINITE = ['supported', 'contradicted', 'mixed'] as const;
const CLAIM: Claim = { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 3 };

function expectAbstained(v: VerificationResult | undefined): void {
  expect(v).toBeDefined();
  expect(v!.status).toBe('unverified');
  expect(v!.noSourceAbstain).toBe(true);
  expect(v!.explanation).toBe(NO_SOURCE_EXPLANATION);
  expect(v!.sources).toEqual([]);
  expect(isBillableVerdict(v)).toBe(false);
}

describe('abstainWithoutSource', () => {
  for (const status of DEFINITE) {
    it(`${status} with no source becomes unverified and keeps every other field`, () => {
      const given = {
        claimId: 'c1', status, explanation: 'model text', sources: [],
        provenance: { provider: 'gemini', model: 'm', verifiedAt: 'T', retriever: 'gemini-grounding', retrievedAt: 'T' },
        webSearchQueries: ['q'], searchEntryPoint: { renderedContent: '<b>x</b>' },
      } satisfies VerificationResult;
      const out = abstainWithoutSource(given);
      expectAbstained(out);
      expect(out.provenance).toEqual(given.provenance);
      expect(out.webSearchQueries).toEqual(['q']);
      expect(out.searchEntryPoint).toEqual({ renderedContent: '<b>x</b>' });
      // A missing sources field counts as no source too.
      expectAbstained(abstainWithoutSource({ claimId: 'c1', status, explanation: 'x' } as unknown as VerificationResult));
    });

    it(`${status} with a source is returned as given`, () => {
      const given: VerificationResult = { claimId: 'c1', status, explanation: 'x', sources: [{ title: 'S', uri: 'https://s.example' }] };
      expect(abstainWithoutSource(given)).toBe(given);
    });
  }

  it('unverified, an API error and a UI state are returned as given', () => {
    const cases: VerificationResult[] = [
      { claimId: 'c1', status: 'unverified', explanation: 'x', sources: [] },
      { claimId: 'c1', status: 'unverified', explanation: 'x', sources: [], apiError: true },
      { claimId: 'c1', status: 'skipped', explanation: 'x', sources: [] },
    ];
    for (const c of cases) expect(abstainWithoutSource(c)).toBe(c);
  });
});

describe('every provider verifyClaim call site applies the rule', () => {
  /** Source files (tests, scripts and dependencies excluded) under the engine, the API and the MCP server. */
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'tests' || name === 'dist' || name.startsWith('.')) continue;
      const p = join(dir, name);
      // Scripts are operator tools, not paths a reader's verdict leaves through.
      if (relative(REPO, p) === join('packages', 'cli', 'scripts')) continue;
      if (statSync(p).isDirectory()) out.push(...sources(p));
      else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
  }

  /** The name of the nearest enclosing named function: a declaration, a method, or the variable a function is assigned to. */
  function enclosingName(node: ts.Node): string {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n)) && n.name) return n.name.getText();
      if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
        return n.parent.name.text;
      }
      if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && ts.isPropertyAssignment(n.parent)) return n.parent.name.getText();
    }
    return '<module>';
  }

  /** Every call whose callee is a property access named verifyClaim, as "file#enclosing function". */
  function verifyClaimCallSites(): string[] {
    const files = [
      ...sources(join(REPO, 'packages/cli')),
      ...sources(join(REPO, 'packages/api/src')),
      ...sources(join(REPO, 'packages/mcp/src')),
    ];
    expect(files.length).toBeGreaterThan(50);
    const sites: string[] = [];
    for (const file of files) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = ts.isNonNullExpression(node.expression) ? node.expression.expression : node.expression;
          if ((ts.isPropertyAccessExpression(callee) || ts.isPropertyAccessChain(callee)) && callee.name.text === 'verifyClaim') {
            sites.push(`${relative(REPO, file).split('\\').join('/')}#${enclosingName(node)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return sites.sort();
  }

  /**
   * Every call to a provider's verifyClaim, one entry per call site (file and
   * nearest enclosing named function). Adding a call site means adding an entry
   * here and a behavioural test that its result passes through
   * abstainWithoutSource.
   * - verify-runner.ts#verifyOneClaim: the runner applies abstainWithoutSource to
   *   every result (the test just below, and every runner test in this file).
   * - admin-verify.ts#verifyOne: packages/api/tests/admin-verify-claims.test.ts,
   *   "counts only the sourced supported verdict as verified: not a zero-source
   *   supported, an unverified or an API error" (the zero-source supported
   *   verdict is reported unverified with noSourceAbstain).
   */
  const CALL_SITES = [
    'packages/api/src/routes/admin-verify.ts#verifyOne',
    'packages/cli/cli/verify-runner.ts#verifyOneClaim',
  ];

  it('each verifyClaim call site is pinned, one entry per call', () => {
    expect(verifyClaimCallSites()).toEqual([...CALL_SITES].sort());
  });

  it('verify-runner.ts#verifyOneClaim: its result reaches the reader through abstainWithoutSource', async () => {
    const provider = { ...createMockProvider(''), verifyClaim: async (c: Claim) => ({ claimId: c.id, status: 'supported' as const, explanation: 'x', sources: [{ title: 'F', uri: 'ftp://source.example/fact' }] }) };
    const run = await runVerification([CLAIM], { provider: provider as LLMProvider, providerName: 'mock', consensusRig: null });
    expectAbstained(run.results[0]);
  });

  it('admin-verify.ts#verifyOne: its behavioural test exists', () => {
    const src = readFileSync(join(REPO, 'packages/api/tests/admin-verify-claims.test.ts'), 'utf8');
    expect(src).toContain("it('counts only the sourced supported verdict as verified: not a zero-source supported, an unverified or an API error'");
    expect(src).toMatch(/noSourceAbstain/);
  });

  it('the Gemini service returns its grounded verdict through abstainWithoutSource', () => {
    const src = readFileSync(join(REPO, 'packages/cli/services/geminiService.ts'), 'utf8');
    expect(src).toMatch(/return abstainWithoutSource\(\{\s*claimId: claim\.id,/);
  });

  it('the full-scan job store passes each verdict through abstainWithoutSource', () => {
    const src = readFileSync(join(REPO, 'packages/api/src/store/full-scan-jobs.ts'), 'utf8');
    expect(src).toMatch(/abstainWithoutSource\(guardVerdict\(/);
  });
});

describe('each single-provider adapter, through the verify runner', () => {
  const run = async (provider: LLMProvider, providerName: string) =>
    (await runVerification([CLAIM], { provider, providerName, consensusRig: null })).results[0];
  const reply = (status: string) => JSON.stringify({ status, explanation: `Model says ${status}.` });

  for (const status of DEFINITE) {
    it(`OpenAI ${status} (never cites a source) is reported as unverified`, async () => {
      const p = createOpenAIProvider('k') as LLMProvider & { callAPI: () => Promise<string> };
      vi.spyOn(p, 'callAPI').mockResolvedValue(reply(status));
      expectAbstained(await run(p, 'openai'));
    });

    it(`Claude ${status} (never cites a source) is reported as unverified`, async () => {
      const p = createClaudeProvider('k') as LLMProvider & { callAPI: () => Promise<string> };
      vi.spyOn(p, 'callAPI').mockResolvedValue(reply(status));
      expectAbstained(await run(p, 'claude'));
    });

    it(`Perplexity ${status} with no citation is reported as unverified; with one it stays ${status}`, async () => {
      const p = createPerplexityProvider('k') as LLMProvider & { callAPIWithCitations: () => Promise<{ content: string; citations: string[] }> };
      const spy = vi.spyOn(p, 'callAPIWithCitations').mockResolvedValue({ content: reply(status), citations: [] });
      expectAbstained(await run(p, 'perplexity'));
      spy.mockResolvedValue({ content: reply(status), citations: ['https://cited.example/a'] });
      const kept = await run(p, 'perplexity');
      expect(kept?.status).toBe(status);
      expect(kept?.explanation).toBe(`Model says ${status}.`);
      expect(kept?.sources).toEqual([{ title: 'https://cited.example/a', uri: 'https://cited.example/a' }]);
      expect(kept && 'noSourceAbstain' in kept).toBe(false);
    });
  }

  it('the mock provider (supported, no source) is reported as unverified', async () => {
    expectAbstained(await run(createMockProvider(''), 'mock'));
  });
});

describe('every engine entry point, with a plugin provider', () => {
  const VERDICTS: Record<string, Omit<VerificationResult, 'claimId'>> = {
    c1: { status: 'supported', explanation: 'p', sources: [] },
    c2: { status: 'contradicted', explanation: 'p', sources: [] },
    c3: { status: 'mixed', explanation: 'p', sources: [] },
    c4: { status: 'supported', explanation: 'p', sources: [{ title: 'S', uri: 'https://s.example/a' }] },
  };
  const CLAIMS: Claim[] = Object.keys(VERDICTS).map((id) => ({ id, text: `Verifiable claim ${id} about the tower.`, type: 'fact', importance: 3 }));
  const TEXT = CLAIMS.map((c) => c.text).join(' ');

  let savedKey: string | undefined;
  let dir = '';
  beforeAll(() => {
    savedKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'plugin-unused';
    registerProvider('no-source-plugin', () => ({
      name: 'No source plugin',
      modelId: 'plugin-v1',
      extractClaims: async () => CLAIMS,
      verifyClaim: async (c: Claim) => ({ claimId: c.id, ...VERDICTS[c.id] }),
      generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
    }) as never);
    dir = mkdtempSync(join(tmpdir(), 'no-source-'));
    writeFileSync(join(dir, 'a.txt'), TEXT);
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  });

  function check(verifications: Record<string, VerificationResult>): void {
    expect(Object.keys(verifications).length).toBe(4);
    for (const id of ['c1', 'c2', 'c3']) expectAbstained(verifications[id]);
    expect(verifications.c4.status).toBe('supported');
    expect(verifications.c4.noSourceAbstain).toBeUndefined();
  }

  it('scan() (quick scan, stream, deep, report, MCP)', async () => {
    const r = await scan(TEXT, 'no-source-plugin');
    check(r.verifications);
  });

  it('verifyFullScan() (full scan)', async () => {
    const r = await verifyFullScan(CLAIMS, { providerName: 'no-source-plugin' });
    const verifications = r.verifications as Record<string, VerificationResult>;
    check(verifications);
  });

  it('batchScan()', async () => {
    const r = await batchScan(dir, 'no-source-plugin');
    expect(r.results.length).toBe(1);
    check(r.results[0].result.verifications);
  });

  it('verification.verifiedClaims counts claims sent to verification, not claims found supported', async () => {
    const r = await scan(TEXT, 'no-source-plugin');
    // verifiedClaims is the number of claims SENT to the verifier (cli/verify-cap.ts), whatever the
    // verdict; it has never meant "verified true". The downgraded claims are sent, so they count here,
    // exactly as any other unverified claim does. They are not counted as supported anywhere.
    expect(r.verification?.verifiedClaims).toBe(4);
    expect(Object.values(r.verifications).filter((v) => v.status === 'supported').length).toBe(1);
    // The plugin has no engine retriever, so none of its verdicts bills; the downgraded ones never could.
    expect(billableVerdictCount(r.verifications)).toBe(0);
  });

  it('a full scan serves only the sourced verdict: a downgraded claim is unserved', async () => {
    const r = await verifyFullScan(CLAIMS, { providerName: 'no-source-plugin' });
    const v = r.verification as { verifiedClaims: number; unservedClaimIds: string[] };
    expect(v.verifiedClaims).toBe(4);
    // Unserved: c1-c3 are unverified; c4 is sourced but a plugin has no engine retriever.
    expect(v.unservedClaimIds).toEqual(expect.arrayContaining(['c1', 'c2', 'c3']));
  });
});

describe('consensus votes, through the verify runner', () => {
  const FTP: Source = { title: 'Fact', uri: 'ftp://source.example/fact' };
  const JS: Source = { title: 'Fact', uri: 'javascript:alert(1)' };
  const HTTPS: Source = { title: 'Fact', uri: 'https://source.example/fact' };

  /** A consensus rig with one OpenAI voter answering `status` against `sources` (no network). */
  function rig(sources: Source[], status = 'supported') {
    const p = createOpenAIProvider('k') as LLMProvider & { callAPI: () => Promise<string> };
    vi.spyOn(p, 'callAPI').mockResolvedValue(JSON.stringify({ status, explanation: `Model says ${status}.` }));
    return { retriever: { name: 'fixture-search', retrieve: async () => sources }, namedProviders: [{ name: 'openai', provider: p }] };
  }

  /** The fused verdict as the same input gives it with the vote rewrite left out. */
  async function fusedWithoutVoteRewrite(sources: Source[]): Promise<VerificationResult> {
    const raw = await consensusVerify(CLAIM, rig(sources).retriever, rig(sources).namedProviders);
    return abstainWithoutSource({ ...raw, providerVotes: undefined });
  }

  function expectSameFused(out: VerificationResult, expected: VerificationResult): void {
    for (const key of ['status', 'explanation', 'sources', 'noSourceAbstain', 'consensus', 'apiError'] as const) {
      expect(out[key]).toEqual(expected[key]);
    }
    expect(out.provenance?.retriever).toBe(expected.provenance?.retriever);
    expect(isBillableVerdict(out)).toBe(isBillableVerdict(expected));
    expect(billableVerdictCount({ c1: out })).toBe(billableVerdictCount({ c1: expected }));
  }

  for (const only of [FTP, JS]) {
    it(`a supported vote whose only source is ${only.uri} reads unverified, in the result and in onClaimVerified`, async () => {
      const seen: VerificationResult[] = [];
      const run = await runVerification([CLAIM], { provider: createMockProvider(''), providerName: 'openai', consensusRig: rig([only]) }, {
        onClaimVerified: (_c, r) => seen.push(r),
      });
      expect(seen.length).toBe(1);
      for (const out of [run.results[0]!, seen[0]]) {
        expect(out.providerVotes?.length).toBe(1);
        const vote = out.providerVotes![0] as ProviderVote;
        expect(vote).toEqual({ provider: 'openai', status: 'unverified', sources: [], explanation: NO_SOURCE_EXPLANATION, noSourceAbstain: true });
        expectAbstained(out);
      }
      expectSameFused(run.results[0]!, await fusedWithoutVoteRewrite([only]));
    });
  }

  it('a supported vote with one https and one ftp source stays supported and keeps only the https source', async () => {
    const run = await runVerification([CLAIM], { provider: createMockProvider(''), providerName: 'openai', consensusRig: rig([HTTPS, FTP]) });
    const out = run.results[0]!;
    expect(out.providerVotes?.length).toBe(1);
    const vote = out.providerVotes![0];
    expect(vote.status).toBe('supported');
    expect(vote.sources).toEqual([HTTPS]);
    expect(vote.explanation).toBe('Model says supported.');
    expect(vote.noSourceAbstain).toBeUndefined();
    expectSameFused(out, await fusedWithoutVoteRewrite([HTTPS, FTP]));
  });

  it('votes are guarded even when the fused verdict is already unverified; other statuses are left as given', () => {
    const unverifiedVote: ProviderVote = { provider: 'claude', status: 'unverified', sources: [FTP], explanation: 'x' };
    const errorVote: ProviderVote = { provider: 'gemini', status: 'unverified', sources: [FTP], apiError: true };
    const given: VerificationResult = {
      claimId: 'c1', status: 'unverified', explanation: 'fused', sources: [FTP],
      providerVotes: [{ provider: 'openai', status: 'contradicted', sources: [FTP], explanation: 'x' }, unverifiedVote, errorVote],
    };
    const out = abstainWithoutSource(given);
    expect(out).not.toBe(given);
    expect(out.status).toBe('unverified');
    expect(out.explanation).toBe('fused');
    expect(out.sources).toEqual([FTP]);
    expect(out.providerVotes).toEqual([
      { provider: 'openai', status: 'unverified', sources: [], explanation: NO_SOURCE_EXPLANATION, noSourceAbstain: true },
      unverifiedVote,
      errorVote,
    ]);
    expect(out.providerVotes![1]).toBe(unverifiedVote);
    expect(out.providerVotes![2]).toBe(errorVote);
    // Nothing to change: the same object comes back.
    const clean: VerificationResult = { claimId: 'c1', status: 'supported', explanation: 'x', sources: [HTTPS], providerVotes: [{ provider: 'openai', status: 'mixed', sources: [HTTPS] }] };
    expect(abstainWithoutSource(clean)).toBe(clean);
  });
});
