// NEXUS: never drop a sentence from checking (emma-soul ruling Dx3 3c631b78, P0 live on main)
/**
 * guaranteeClaimPerSentence used to count a sentence as covered when any claim
 * began like it (the first 40 normalised characters). A claim that changed a
 * detail after character 40 ("within 90 hours" checked as "within 90 days")
 * then left the sentence as written unchecked. Now a sentence is covered only
 * when a claim holds the whole sentence. Otherwise it is checked again as
 * written: a coverage re-check, never billed, never in the full-scan quote,
 * ranked after every extracted claim under the verify cap.
 *
 * Real path for the scan cases: scan() -> verify runner -> geminiService, the
 * Gemini SDK mocked at the module boundary and fetch stubbed for Parallel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  extracted: [] as Array<Record<string, unknown>>,
  prompts: [] as string[],
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { contents?: unknown }) => {
        const texts = (v: unknown): string[] => typeof v === 'string' ? [v]
          : Array.isArray(v) ? v.flatMap(texts)
          : v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => (k === 'text' || k === 'parts') ? texts(x) : [])
          : [];
        const prompt = texts(params.contents).join('\n');
        sdk.prompts.push(prompt);
        if (!prompt.includes('Claim: "')) return { text: JSON.stringify(sdk.extracted), candidates: [{ finishReason: 'STOP' }] };
        return { text: JSON.stringify({ status: 'supported', sourcesAddressClaim: true, explanation: 'judge words' }), candidates: [{ finishReason: 'STOP' }] };
      },
    };
  },
}));

import { scan, guaranteeClaimPerSentence, extractForFullScan } from '../cli/scan';
import { rankEligibleClaims } from '../cli/verify-cap';
import { isBillableVerdict, billableVerdictCount, billingSummary } from '../lib/verdict-guard';
import type { Claim, VerificationResult } from '../types';

const claim = (id: string, text: string, importance = 3): Claim => ({ id, text, type: 'fact', importance });

const HOURS = 'We allow refunds for all customers travelling within 90 hours.';
const DAYS = 'We allow refunds for all customers travelling within 90 days.';
const FIRST = 'Example Air operates flights.';

describe('a sentence is covered only by a claim that holds all of it', () => {
  it('90 hours checked as 90 days: the sentence as written is checked again (it was dropped before)', () => {
    const out = guaranteeClaimPerSentence(`${FIRST} ${HOURS}`, [claim('c1', FIRST), claim('c2', DAYS)]);
    const recheck = out.filter((c) => c.coverageRecheck === true);
    expect(recheck).toHaveLength(1);
    expect(recheck[0]).toMatchObject({ text: HOURS, type: 'fact', coverageRecheck: true });
    expect(recheck[0].id.startsWith('s')).toBe(true);
  });

  it('a claim that holds the whole sentence covers it: no re-check', () => {
    const out = guaranteeClaimPerSentence(`${FIRST} ${HOURS}`, [claim('c1', FIRST), claim('c2', HOURS)]);
    expect(out.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('a sentence no claim relates to is still added as an ordinary claim, billed as before', () => {
    const out = guaranteeClaimPerSentence(`${FIRST} ${HOURS}`, [claim('c1', FIRST)]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ text: HOURS, importance: 3 });
    expect('coverageRecheck' in out[1]).toBe(false);
  });

  it('the re-check keeps the importance of the claim that began like it, at least 2, so it stays eligible', () => {
    const low = guaranteeClaimPerSentence(`${FIRST} ${HOURS}`, [claim('c1', FIRST), claim('c2', DAYS, 1)]);
    expect(low.find((c) => c.coverageRecheck)?.importance).toBe(2);
    const high = guaranteeClaimPerSentence(`${FIRST} ${HOURS}`, [claim('c1', FIRST), claim('c2', DAYS, 5)]);
    expect(high.find((c) => c.coverageRecheck)?.importance).toBe(5);
  });
});

describe('the holes the codex seat found in df6c239', () => {
  it('a single-sentence input gets the same guarantee', () => {
    const out = guaranteeClaimPerSentence(HOURS, [claim('c1', DAYS)]);
    expect(out.filter((c) => c.coverageRecheck === true).map((c) => c.text)).toEqual([HOURS]);
    expect(guaranteeClaimPerSentence(HOURS, [claim('c1', HOURS)]).map((c) => c.id)).toEqual(['c1']);
  });

  it('a decimal point is kept: "1.5 mg" is not covered by "15 mg"', () => {
    const dose = 'The recommended starting dose for adults is 1.5 mg per day.';
    const out = guaranteeClaimPerSentence(`${FIRST} ${dose}`, [claim('c1', FIRST), claim('c2', 'The recommended starting dose for adults is 15 mg per day.')]);
    expect(out.filter((c) => c.coverageRecheck === true).map((c) => c.text)).toEqual([dose]);
    // The same figure written the same way still covers it.
    expect(guaranteeClaimPerSentence(`${FIRST} ${dose}`, [claim('c1', FIRST), claim('c2', dose)]).map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('a percent sign is kept: "90%" is not covered by "90"', () => {
    const pct = 'Customers who travel within the same week receive 90% of the fare back.';
    const out = guaranteeClaimPerSentence(`${FIRST} ${pct}`, [claim('c1', FIRST), claim('c2', 'Customers who travel within the same week receive 90 of the fare back.')]);
    expect(out.filter((c) => c.coverageRecheck === true).map((c) => c.text)).toEqual([pct]);
  });

  it('a claim that holds the sentence but denies it does not cover it', () => {
    const dose = 'The recommended starting dose for adults is 1.5 mg per day.';
    for (const denial of [`It is not true that ${dose}`, `It is false that ${dose}`, `Nobody says that ${dose}`]) {
      const out = guaranteeClaimPerSentence(`${FIRST} ${dose}`, [claim('c1', FIRST), claim('c2', denial)]);
      expect(out.filter((c) => c.text === dose)).toHaveLength(1);
    }
    // A sentence that is itself negative is covered by a claim that keeps the negation.
    const neg = 'Refunds are not available after travel has been completed.';
    expect(guaranteeClaimPerSentence(`${FIRST} ${neg}`, [claim('c1', FIRST), claim('c2', neg)]).map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});

describe('under the verify cap a re-check never displaces an extracted claim', () => {
  it('ranks every re-check after every extracted claim, whatever the importance', () => {
    const ranked = rankEligibleClaims([
      { ...claim('s9', HOURS, 5), coverageRecheck: true },
      claim('c1', FIRST, 2),
      claim('c2', DAYS, 3),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(['c2', 'c1', 's9']);
  });
});

describe('a re-check verdict is never billed', () => {
  const billable: VerificationResult = {
    claimId: 's9', status: 'supported', explanation: 'x',
    sources: [{ title: 'T', uri: 'https://example.com/a' }],
    provenance: { provider: 'gemini', model: 'm', verifiedAt: '2026-11-23T00:00:00Z', retriever: 'parallel-search' },
  } as VerificationResult;

  it('isBillableVerdict refuses it; billingSummary names coverage_recheck', () => {
    expect(isBillableVerdict(billable)).toBe(true);
    const recheck = { ...billable, coverageRecheck: true };
    expect(isBillableVerdict(recheck)).toBe(false);
    expect(billableVerdictCount({ c2: { ...billable, claimId: 'c2' }, s9: recheck })).toBe(1);
    expect(billingSummary({ c2: { ...billable, claimId: 'c2' }, s9: recheck })).toEqual({
      billedClaims: 1, unbilledClaims: 1, unbilled: [{ claimId: 's9', reason: 'coverage_recheck' }],
    });
  });
});

describe('end to end through scan() and the full-scan estimate', () => {
  const mockFetch = vi.fn();
  const ENV = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'PARALLEL_API_KEY', 'FAULTLINE_GROUNDING', 'FAULTLINE_PARALLEL_MODE'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.GEMINI_API_KEY = 'g';
    process.env.PARALLEL_API_KEY = 'p';
    delete process.env.OPENAI_API_KEY;
    delete process.env.FAULTLINE_GROUNDING;
    delete process.env.FAULTLINE_PARALLEL_MODE;
    sdk.prompts.length = 0;
    sdk.extracted = [
      { id: 'c1', text: FIRST, type: 'fact', importance: 3 },
      { id: 'c2', text: DAYS, type: 'fact', importance: 4 },
    ];
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({
      search_id: 's', results: [{ url: 'https://p.example/policy', title: 'Policy', excerpts: ['Refunds within 90 days.'] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('scan(): the sentence as written is verified, and its verdict is not billed', async () => {
    const result = await scan(`${FIRST} ${HOURS}`, 'gemini', undefined, undefined, undefined, undefined, undefined, { grounding: 'parallel' });
    const recheck = result.claims.find((c) => c.coverageRecheck === true);
    expect(recheck?.text).toBe(HOURS);
    const v = result.verifications[recheck!.id];
    expect(v).toBeDefined();
    expect(v.status).toBe('supported');
    expect(v.coverageRecheck).toBe(true);
    expect(sdk.prompts.some((p) => p.includes(`Claim: "${HOURS}"`))).toBe(true);
    const billing = billingSummary(result.verifications);
    expect(billing.billedClaims).toBe(2);
    expect(billing.unbilled).toEqual([{ claimId: recheck!.id, reason: 'coverage_recheck' }]);
  });

  it('extractForFullScan: the re-check is a fact claim to verify but not in the units quoted', async () => {
    // Eight extracted facts that each begin like their sentence but change it: one unit,
    // and eight re-checks that must not make it two.
    const pairs = Array.from({ length: 8 }, (_, i) => [
      `We allow refunds for all customers travelling within ${i + 1}0 hours.`,
      `We allow refunds for all customers travelling within ${i + 1}0 days.`,
    ]);
    sdk.extracted = pairs.map(([, said], i) => ({ id: `c${i + 1}`, text: said, type: 'fact', importance: 3 }));
    const est = await extractForFullScan(pairs.map(([written]) => written).join(' '), 'gemini');
    expect(est.claims.filter((c) => c.coverageRecheck === true)).toHaveLength(8);
    expect(est.factClaims).toBe(16);
    expect(est.units).toBe(1);
  });
});
