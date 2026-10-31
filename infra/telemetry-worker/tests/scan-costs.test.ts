/**
 * POST /scan-costs accepts the provider label the API writes. A scan that runs
 * extraction and verification on different providers, or a consensus scan, is
 * labelled with every provider it ran on joined by '+' (for example
 * 'openai+gemini+claude'). The worker used to accept only one provider name, so
 * it answered 422 and dropped every such cost event.
 */
import { describe, it, expect } from 'vitest';
import worker, { isAllowedProviderLabel, type Env } from '../src/index';

interface Insert {
  sql: string;
  values: unknown[];
}

/** A D1 stand-in that records each statement bound and run. */
function fakeEnv(): { env: Env; inserts: Insert[] } {
  const inserts: Insert[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              inserts.push({ sql, values });
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { env: { DB: db } as unknown as Env, inserts };
}

function costEvent(provider: unknown): Record<string, unknown> {
  return {
    event: 'scan_cost',
    ts: '2026-10-28T12:00:00.000Z',
    scan_id: '6f1c2a9e-4b7d-4c3e-9a1f-2d8e5b7c0a14',
    tier: 'enterprise',
    key_mode: 'managed',
    provider,
    model_id: 'gpt-4o-mini',
    input_tokens: 1200,
    output_tokens: 300,
    grounding_calls: 3,
    cost_usd: 0.0123,
    latency_ms: 2400,
    cache_hit: false,
    kind: 'scan',
  };
}

async function post(provider: unknown): Promise<{ status: number; inserts: Insert[] }> {
  const { env, inserts } = fakeEnv();
  const res = await worker.fetch(new Request('https://telemetry.test/scan-costs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(costEvent(provider)),
  }), env);
  return { status: res.status, inserts };
}

describe('POST /scan-costs provider label', () => {
  for (const label of ['gemini', 'openai+gemini', 'openai+gemini+claude', 'perplexity+openai', 'mock']) {
    it(`accepts '${label}' and stores it as sent`, async () => {
      const { status, inserts } = await post(label);
      expect(status).toBe(201);
      expect(inserts).toHaveLength(1);
      expect(inserts[0].sql).toContain('INSERT OR IGNORE INTO scan_cost_events');
      expect(inserts[0].values[4]).toBe(label);
    });
  }

  const refused: Array<[string, unknown]> = [
    ['an unknown provider', 'acme'],
    ['a list with one unknown part', 'openai+acme'],
    ['an empty part', 'openai++gemini'],
    ['a trailing separator', 'openai+'],
    ['a repeated provider', 'openai+openai'],
    ['another separator', 'openai,gemini'],
    ['padding around a name', 'openai + gemini'],
    ['the empty string', ''],
    ['a non-string', 42],
  ];
  for (const [name, label] of refused) {
    it(`refuses ${name} with 422 and stores nothing`, async () => {
      const { status, inserts } = await post(label);
      expect(status).toBe(422);
      expect(inserts).toHaveLength(0);
    });
  }
});

describe('isAllowedProviderLabel', () => {
  it('accepts each known provider alone and every known pair', () => {
    const known = ['gemini', 'openai', 'claude', 'perplexity', 'mock'];
    const pairs = known.flatMap((a) => known.filter((b) => b !== a).map((b) => `${a}+${b}`));
    expect(pairs.length).toBe(20);
    for (const label of [...known, ...pairs]) expect(isAllowedProviderLabel(label)).toBe(true);
  });

  it('is case sensitive, as the API writes lower-case names', () => {
    expect(isAllowedProviderLabel('OpenAI')).toBe(false);
    expect(isAllowedProviderLabel('openai+Gemini')).toBe(false);
  });
});
