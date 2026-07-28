import { describe, it, expect, vi } from 'vitest';
import {
  resolveTransport,
  hostedScan,
  runScan,
  isGrounded,
  HostedScanError,
  DEFAULT_API_URL,
} from '../cli/transport';
import type { ScanResult } from '../cli/scan';

const OK_RESULT: ScanResult = {
  input: 'x',
  provider: 'Google Gemini',
  claims: [{ id: 'c1', text: 'Claim', type: 'fact', importance: 5 }],
  verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] } },
  overallRisk: 'low',
  complianceReport: {} as ScanResult['complianceReport'],
  ruleFindings: [],
  verificationErrors: 0,
  degraded: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('resolveTransport', () => {
  it('is local when no API key and no explicit URL are set', () => {
    expect(resolveTransport({})).toEqual({ mode: 'local' });
  });

  it('is hosted when an API key is present, defaulting the URL', () => {
    const t = resolveTransport({ FAULTLINE_API_KEY: 'k' });
    expect(t.mode).toBe('hosted');
    expect(t.apiUrl).toBe(DEFAULT_API_URL);
  });

  it('honours an explicit FAULTLINE_API_URL', () => {
    const t = resolveTransport({ FAULTLINE_API_KEY: 'k', FAULTLINE_API_URL: 'https://x.test' });
    expect(t.apiUrl).toBe('https://x.test');
  });

  it('forces hosted when --api-url is given, so a named server is never silently bypassed', () => {
    const t = resolveTransport({}, 'https://x.test');
    expect(t.mode).toBe('hosted');
    expect(t.apiKey).toBeUndefined();
  });
});

describe('hostedScan', () => {
  it('posts to /scan with the key header and returns the result', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_RESULT));
    const result = await hostedScan(
      'text',
      'gemini',
      { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'secret' },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.claims).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/scan');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('secret');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'text', provider: 'gemini' });
  });

  it('strips a trailing slash from the base URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_RESULT));
    await hostedScan(
      't',
      undefined,
      { mode: 'hosted', apiUrl: 'https://x.test/', apiKey: 'k' },
      fetchImpl as unknown as typeof fetch,
    );
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://x.test/scan');
  });

  it('omits provider when none is chosen, letting the server default apply', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_RESULT));
    await hostedScan(
      't',
      undefined,
      { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'k' },
      fetchImpl as unknown as typeof fetch,
    );
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ text: 't' });
  });

  it('refuses to run hosted without a key rather than falling back silently', async () => {
    await expect(
      hostedScan('t', undefined, { mode: 'hosted', apiUrl: 'https://x.test' }),
    ).rejects.toThrow(/FAULTLINE_API_KEY/);
  });

  it('explains a 401 as a key problem', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, 401));
    await expect(
      hostedScan(
        't',
        undefined,
        { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'bad' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/401/);
  });

  it('says a 429 is not a verdict on the claims', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'slow down' }, 429));
    await expect(
      hostedScan(
        't',
        undefined,
        { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'k' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/NOT a verdict/);
  });

  it('surfaces a network failure as "nothing was verified"', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      hostedScan(
        't',
        undefined,
        { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'k' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Nothing was verified/);
  });

  it('rejects an unrecognised response shape instead of returning empty claims', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));
    await expect(
      hostedScan(
        't',
        undefined,
        { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'k' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(HostedScanError);
  });
});

describe('runScan', () => {
  it('uses the local engine in local mode', async () => {
    const scanFn = vi.fn(async () => OK_RESULT);
    const fetchImpl = vi.fn();
    await runScan('t', 'gemini', { mode: 'local' }, {
      scanFn: scanFn as unknown as typeof import('../cli/scan').scan,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(scanFn).toHaveBeenCalledWith('t', 'gemini');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the API in hosted mode', async () => {
    const scanFn = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse(OK_RESULT));
    await runScan('t', undefined, { mode: 'hosted', apiUrl: 'https://x.test', apiKey: 'k' }, {
      scanFn: scanFn as unknown as typeof import('../cli/scan').scan,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(scanFn).not.toHaveBeenCalled();
  });
});

describe('isGrounded', () => {
  it('treats the unspecified default as grounded — both transports default to gemini', () => {
    expect(isGrounded()).toBe(true);
    expect(isGrounded('')).toBe(true);
  });

  it('recognises gemini in flag and display form', () => {
    expect(isGrounded('gemini')).toBe(true);
    expect(isGrounded('Google Gemini')).toBe(true);
  });

  it('does not claim grounding for providers that judge from model knowledge', () => {
    for (const p of ['openai', 'OpenAI', 'claude', 'perplexity', 'mock']) {
      expect(isGrounded(p)).toBe(false);
    }
  });
});
