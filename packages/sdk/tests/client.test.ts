import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FaultlineClient,
  FaultlineError,
  type ApiKey,
  type BatchScanResponse,
  type ComplianceExportResponse,
  type DashboardResponse,
  type ScanResult,
  type UsageResponse,
  type Webhook,
  type WebhookPublic,
} from '../src/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeEmptyResponse(status: number): Response {
  return new Response(null, { status });
}

function makeBinaryResponse(buffer: ArrayBuffer, status = 200): Response {
  return new Response(buffer, {
    status,
    headers: { 'Content-Type': 'application/pdf' },
  });
}

function makeScanResult(): ScanResult {
  return {
    input: 'GPT-4 was released in March 2023.',
    provider: 'gemini',
    claims: [
      {
        id: 'claim-uuid-1',
        text: 'GPT-4 was released in March 2023.',
        type: 'fact',
        importance: 4,
      },
    ],
    verifications: {
      'claim-uuid-1': {
        claimId: 'claim-uuid-1',
        status: 'supported',
        explanation: 'Multiple sources confirm this.',
        sources: [{ title: 'OpenAI Blog', uri: 'https://openai.com/gpt-4' }],
      },
    },
    overallRisk: 'low',
    complianceReport: {
      generatedAt: '2026-03-18T10:00:00.000Z',
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
      confidenceDistribution: { high: 1, medium: 0, low: 0 },
    },
    ruleFindings: [],
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let client: FaultlineClient;

beforeEach(() => {
  client = new FaultlineClient({
    apiKey: 'test-api-key-abc123',
    baseUrl: 'http://localhost:3000',
  });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('scan()', () => {
  it('sends POST /scan with correct body and x-api-key header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(makeScanResult()));
    vi.stubGlobal('fetch', mockFetch);

    await client.scan('GPT-4 was released in March 2023.', 'gemini');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/scan');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(
      'test-api-key-abc123',
    );
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.text).toBe('GPT-4 was released in March 2023.');
    expect(body.provider).toBe('gemini');
  });

  it('returns a parsed ScanResult', async () => {
    const expected = makeScanResult();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(expected)));

    const result = await client.scan('GPT-4 was released in March 2023.');

    expect(result.input).toBe(expected.input);
    expect(result.overallRisk).toBe('low');
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.id).toBe('claim-uuid-1');
    expect(result.verifications['claim-uuid-1']?.status).toBe('supported');
  });

  it('throws FaultlineError on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeJsonResponse({ error: 'Unauthorized. Provide a valid x-api-key header.' }, 401),
      ),
    );

    await expect(client.scan('some text')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof FaultlineError &&
        err.status === 401 &&
        err.message.includes('Unauthorized')
      );
    });
  });

  it('throws FaultlineError on 429', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeJsonResponse(
          { error: 'Rate limit exceeded.', limit: 10, remaining: 0, resetEpoch: 1742400000 },
          429,
        ),
      ),
    );

    await expect(client.scan('some text')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof FaultlineError &&
        err.status === 429 &&
        err.message.includes('Rate limit exceeded')
      );
    });
  });
});

describe('scanBatch()', () => {
  it('sends POST /scan/batch with correct texts array', async () => {
    const batchResponse: BatchScanResponse = {
      total: 2,
      succeeded: 2,
      failed: 0,
      results: [makeScanResult(), makeScanResult()],
      errors: [],
    };
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(batchResponse));
    vi.stubGlobal('fetch', mockFetch);

    await client.scanBatch(['text one', 'text two'], 'mock');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/scan/batch');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.texts).toEqual(['text one', 'text two']);
    expect(body.provider).toBe('mock');
  });

  it('returns BatchScanResponse with total, succeeded, failed fields', async () => {
    const batchResponse: BatchScanResponse = {
      total: 3,
      succeeded: 2,
      failed: 1,
      results: [makeScanResult(), null, makeScanResult()],
      errors: [{ index: 1, error: 'Provider failure.' }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeJsonResponse(batchResponse)));

    const result = await client.scanBatch(['a', 'b', 'c']);

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results).toHaveLength(3);
    expect(result.results[1]).toBeNull();
    expect(result.errors[0]?.index).toBe(1);
  });
});

describe('createKey()', () => {
  it('sends POST /keys and returns ApiKey with key field', async () => {
    const created: ApiKey = {
      id: 'key-uuid-1',
      name: 'CI pipeline key',
      permissions: ['scan', 'report'],
      createdAt: '2026-03-18T09:00:00.000Z',
      key: 'raw-secret-key-value-abc123',
    };
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(created, 201));
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.createKey('CI pipeline key', ['scan', 'report']);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/keys');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.name).toBe('CI pipeline key');
    expect(body.permissions).toEqual(['scan', 'report']);
    expect(result.key).toBe('raw-secret-key-value-abc123');
    expect(result.id).toBe('key-uuid-1');
  });
});

describe('listKeys()', () => {
  it('sends GET /keys and returns array of ApiKey', async () => {
    const keys: ApiKey[] = [
      {
        id: 'key-uuid-1',
        name: 'CI pipeline key',
        permissions: ['scan'],
        createdAt: '2026-03-18T09:00:00.000Z',
      },
      {
        id: 'key-uuid-2',
        name: 'Admin key',
        permissions: ['admin', 'scan'],
        createdAt: '2026-03-17T08:00:00.000Z',
      },
    ];
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(keys));
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.listKeys();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/keys');
    expect(init.method).toBe('GET');
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('CI pipeline key');
    // key field must not be present in list responses
    expect(result[0]?.key).toBeUndefined();
  });
});

describe('deleteKey()', () => {
  it('sends DELETE /keys/:id and resolves void on 204', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeEmptyResponse(204));
    vi.stubGlobal('fetch', mockFetch);

    await expect(client.deleteKey('key-uuid-1')).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/keys/key-uuid-1');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(
      'test-api-key-abc123',
    );
  });

  it('throws FaultlineError on 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeJsonResponse({ error: 'Key not found.' }, 404),
      ),
    );

    await expect(client.deleteKey('nonexistent-uuid')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof FaultlineError &&
        err.status === 404 &&
        err.message === 'Key not found.',
    );
  });
});

describe('createWebhook()', () => {
  it('sends POST /webhooks with correct body and returns Webhook with secret', async () => {
    const webhook: Webhook = {
      id: 'wh-uuid-1',
      url: 'https://example.com/hooks/faultline',
      events: ['scan.complete', 'scan.failed'],
      createdAt: '2026-03-18T09:00:00.000Z',
      secret: 'hmac-secret-xyz',
    };
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(webhook, 201));
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.createWebhook(
      'https://example.com/hooks/faultline',
      ['scan.complete', 'scan.failed'],
      'hmac-secret-xyz',
    );

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/webhooks');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.url).toBe('https://example.com/hooks/faultline');
    expect(body.events).toEqual(['scan.complete', 'scan.failed']);
    expect(body.secret).toBe('hmac-secret-xyz');
    expect(result.secret).toBe('hmac-secret-xyz');
    expect(result.id).toBe('wh-uuid-1');
  });
});

describe('listWebhooks()', () => {
  it('returns array of WebhookPublic without secret field', async () => {
    const webhooks: WebhookPublic[] = [
      {
        id: 'wh-uuid-1',
        url: 'https://example.com/hooks/faultline',
        events: ['scan.complete'],
        createdAt: '2026-03-18T09:00:00.000Z',
      },
    ];
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(webhooks));
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.listWebhooks();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/webhooks');
    expect(init.method).toBe('GET');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('wh-uuid-1');
    expect((result[0] as unknown as Record<string, unknown>)['secret']).toBeUndefined();
  });
});

describe('deleteWebhook()', () => {
  it('sends DELETE /webhooks/:id and resolves void on 204', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeEmptyResponse(204));
    vi.stubGlobal('fetch', mockFetch);

    await expect(client.deleteWebhook('wh-uuid-1')).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/webhooks/wh-uuid-1');
    expect(init.method).toBe('DELETE');
  });
});

describe('getUsage()', () => {
  it('returns UsageResponse with keyId and usage map', async () => {
    const usage: UsageResponse = {
      keyId: 'key-uuid-1',
      usage: {
        '2026-03-17': 5,
        '2026-03-18': 12,
      },
    };
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(usage));
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.getUsage();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/usage');
    expect(init.method).toBe('GET');
    expect(result.keyId).toBe('key-uuid-1');
    expect(result.usage['2026-03-18']).toBe(12);
  });
});

describe('getDashboard()', () => {
  it('returns DashboardResponse with scans, riskDistribution, keyUsage', async () => {
    const dashboard: DashboardResponse = {
      scans: { today: 66, week: 340, month: 1200 },
      riskDistribution: { low: 42, medium: 15, high: 7, critical: 2 },
      keyUsage: [{ keyId: 'key-uuid-1', today: 8 }],
    };
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(dashboard));
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.getDashboard();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/dashboard');
    expect(init.method).toBe('GET');
    expect(result.scans.today).toBe(66);
    expect(result.scans.week).toBe(340);
    expect(result.scans.month).toBe(1200);
    expect(result.riskDistribution.critical).toBe(2);
    expect(result.keyUsage[0]?.keyId).toBe('key-uuid-1');
    expect(result.keyUsage[0]?.today).toBe(8);
  });
});

// ── Compliance Export (N-201) ────────────────────────────────────────────────

describe('complianceExport()', () => {
  it('SDK-CE1: fetches JSON compliance export', async () => {
    const body: ComplianceExportResponse = {
      entries: [{
        id: 'ch-1', projectName: 'proj', scanId: 's1',
        complianceScore: 85, pass: true, overallRisk: 'Low',
        nonCompliantCount: 0, totalArticles: 8, threshold: 70,
        recordedAt: '2026-03-31T12:00:00Z',
      }],
      count: 1,
      exportedAt: '2026-03-31T12:01:00Z',
    };
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(body));
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.complianceExport();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/compliance/export');
    expect(init.method).toBe('GET');
    expect(result.count).toBe(1);
    expect(result.entries[0].complianceScore).toBe(85);
  });

  it('SDK-CE2: passes projectName filter', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse({ entries: [], count: 0, exportedAt: '' }));
    vi.stubGlobal('fetch', mockFetch);

    await client.complianceExport({ projectName: 'my-project' });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('projectName=my-project');
  });

  it('SDK-CE3: passes since filter', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse({ entries: [], count: 0, exportedAt: '' }));
    vi.stubGlobal('fetch', mockFetch);

    await client.complianceExport({ since: '2026-03-01' });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('since=2026-03-01');
  });
});

describe('ScanResult inline compliance fields', () => {
  it('SDK-CS1: ScanResult type accepts complianceScore and compliancePass', () => {
    const result = makeScanResult();
    result.complianceScore = 72;
    result.compliancePass = true;
    expect(result.complianceScore).toBe(72);
    expect(result.compliancePass).toBe(true);
  });
});
