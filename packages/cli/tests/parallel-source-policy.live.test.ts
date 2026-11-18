/**
 * Opt-in live check of Parallel's source_policy field names.
 *
 * One paid Search API call (mode `fast`, about 0.001 USD). Skipped unless
 * PARALLEL_API_KEY is set. CI does not set that key. Run it by hand before
 * relying on the allowlist in production:
 *
 *   PARALLEL_API_KEY=... npx vitest run tests/parallel-source-policy.live.test.ts
 *
 * A 422 means Parallel refused `advanced_settings.source_policy`. Do not point
 * this file at a mock.
 */
import { describe, expect, it } from 'vitest';
import { PARALLEL_SEARCH_URL, ParallelSearchRetriever } from '../providers/parallel_search_retriever';
import { assertSourcePolicy } from '../cli/source-policy';

const apiKey = (process.env.PARALLEL_API_KEY ?? '').trim();

describe.skipIf(apiKey === '')('Parallel source_policy live contract (paid; opt-in)', () => {
  it('accepts advanced_settings.source_policy.include_domains on POST /v1/search', async () => {
    const retriever = new ParallelSearchRetriever(apiKey, {
      mode: 'fast',
      sourcePolicy: assertSourcePolicy('cms.gov'),
    });
    const body = retriever.requestBody('CMS Medicare inpatient payment update');
    const settings = body.advanced_settings as {
      source_policy?: { include_domains?: string[]; exclude_domains?: string[]; after_date?: string };
      fetch_policy?: unknown;
    };
    expect(settings.source_policy).toEqual({ include_domains: ['cms.gov'] });
    expect(settings.fetch_policy).toBeUndefined();

    const response = await fetch(PARALLEL_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).not.toBe(422);
    expect(response.ok, text.slice(0, 300)).toBe(true);
    const payload = JSON.parse(text) as { results?: unknown };
    expect(Array.isArray(payload.results)).toBe(true);
  }, 30_000);
});
