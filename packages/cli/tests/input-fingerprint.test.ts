// NEXUS: the audit record fingerprints the whole checked text (Air Canada proof pack finding 2)
/**
 * A scan result kept only the first 200 characters of its input, so an audit
 * report could not prove which text was checked: its "Input SHA-256" was a hash
 * of the preview. Scan results now carry inputSha256 and inputChars over the
 * whole scanned text, on both scan paths; `input` stays a 200-character preview.
 *
 * Real path: scan() -> verify runner -> geminiService, the Gemini SDK mocked at
 * the module boundary and fetch stubbed for Parallel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

const sdk = vi.hoisted(() => ({
  claims: [] as Array<{ id: string; text: string; type: string; importance: number }>,
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
        if (!prompt.includes('Claim: "')) return { text: JSON.stringify(sdk.claims), candidates: [{ finishReason: 'STOP' }] };
        return { text: JSON.stringify({ status: 'supported', sourcesAddressClaim: true, explanation: 'judge words' }), candidates: [{ finishReason: 'STOP' }] };
      },
    };
  },
}));

import { scan, inputFingerprint } from '../cli/scan';

const TRUE_FACT = 'The Eiffel Tower was completed in 1889.';
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
  sdk.claims = [{ id: 't1', text: TRUE_FACT, type: 'fact', importance: 3 }];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({
    search_id: 's', results: [{ url: 'https://p.example/tower', title: 'Tower', excerpts: ['Completed in 1889.'] }],
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

const runScan = (text: string, mode?: 'full') =>
  scan(text, 'gemini', undefined, undefined, undefined, undefined, undefined, { grounding: 'parallel', ...(mode ? { mode } : {}) });

describe('the scan result fingerprints the whole input', () => {
  const long = `${TRUE_FACT} ${'More context about the tower and its history. '.repeat(8)}The tower is in Paris.`;

  it('records SHA-256 and code-point count of the full text, past the 200-character preview', async () => {
    expect(long.length).toBeGreaterThan(300);
    const result = await runScan(long);
    expect(result.input).toBe(long.substring(0, 200));
    expect(result.inputSha256).toBe(createHash('sha256').update(long, 'utf8').digest('hex'));
    expect(result.inputChars).toBe([...long].length);
    // A change past character 200 changes the fingerprint, which the preview cannot show.
    const again = await runScan(`${long.slice(0, -1)}!`);
    expect(again.input).toBe(result.input);
    expect(again.inputSha256).not.toBe(result.inputSha256);
  });

  it('the full-scan path records the same fingerprint', async () => {
    const result = await runScan(long, 'full');
    expect(result.inputSha256).toBe(createHash('sha256').update(long, 'utf8').digest('hex'));
    expect(result.inputChars).toBe([...long].length);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(inputFingerprint(`${TRUE_FACT} 🗼🗼`).inputChars).toBe(TRUE_FACT.length + 3);
    expect(inputFingerprint('').inputSha256).toBe(createHash('sha256').update('', 'utf8').digest('hex'));
  });
});
