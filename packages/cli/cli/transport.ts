/**
 * Scan transport — hosted API or local engine, one interface.
 *
 * The guard subcommand and the MCP server both need to run a scan, and both
 * need to work in two situations:
 *
 *   HOSTED — `FAULTLINE_API_KEY` is set. The scan runs on our API, which holds
 *            server-side provider keys. The caller needs no provider key of
 *            their own. This is the paid path.
 *
 *   LOCAL  — no API key. The scan runs in-process against the caller's own
 *            provider key (`GEMINI_API_KEY` and friends). This is the free
 *            path, and it is what the published CLI has always done.
 *
 * Resolution is by credential, not by flag, so the common case needs no
 * configuration: set an API key and you are hosted, set a provider key and you
 * are local, set neither and you get `mock` with a warning.
 */

import { scan, type ScanResult } from './scan.js';

/** Hosted API used when FAULTLINE_API_URL is not set explicitly. */
export const DEFAULT_API_URL = 'https://faultline-api.fly.dev';

export type TransportMode = 'hosted' | 'local';

export interface Transport {
  mode: TransportMode;
  /** Base URL, hosted mode only. */
  apiUrl?: string;
  /** Present in hosted mode. Never logged. */
  apiKey?: string;
}

/**
 * Decide how to run the scan.
 *
 * An explicit `apiUrl` (from --api-url) forces hosted mode, because a caller
 * naming a server means to use it; a missing key in that case is an error the
 * caller should see rather than a silent fallback to a different engine.
 */
export function resolveTransport(
  env: NodeJS.ProcessEnv = process.env,
  explicitApiUrl?: string,
): Transport {
  const apiKey = env.FAULTLINE_API_KEY;
  const apiUrl = explicitApiUrl || env.FAULTLINE_API_URL;

  if (apiKey || explicitApiUrl) {
    return { mode: 'hosted', apiUrl: apiUrl || DEFAULT_API_URL, apiKey };
  }
  return { mode: 'local' };
}

/** Thrown when the hosted API refuses or fails a scan. */
export class HostedScanError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HostedScanError';
  }
}

function explainStatus(status: number, body: string): string {
  switch (status) {
    case 401:
      return 'the API rejected the key (401). Check FAULTLINE_API_KEY.';
    case 403:
      return 'the key lacks permission for this operation (403).';
    case 429:
      return 'rate limit or monthly cap reached (429). This is NOT a verdict on your claims.';
    case 503:
      return `the API is not ready to scan (503): ${body}`;
    default:
      return `the API returned ${status}: ${body}`;
  }
}

/** Run a scan through the hosted API. */
export async function hostedScan(
  text: string,
  provider: string | undefined,
  transport: Transport,
  fetchImpl: typeof fetch = fetch,
): Promise<ScanResult> {
  if (!transport.apiKey) {
    throw new HostedScanError(
      'hosted mode requires FAULTLINE_API_KEY. Set it, or unset FAULTLINE_API_URL to run ' +
        'locally against your own provider key.',
    );
  }

  const url = `${transport.apiUrl!.replace(/\/+$/, '')}/scan`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': transport.apiKey },
      body: JSON.stringify(provider ? { text, provider } : { text }),
    });
  } catch (err) {
    throw new HostedScanError(
      `could not reach ${url} — ${err instanceof Error ? err.message : String(err)}. ` +
        'Nothing was verified.',
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HostedScanError(explainStatus(res.status, body.slice(0, 300)), res.status);
  }

  const json = (await res.json()) as ScanResult;
  if (!json || !Array.isArray(json.claims)) {
    throw new HostedScanError('the API returned an unrecognised response shape.');
  }
  return json;
}

/**
 * Run a scan on whichever transport is configured.
 *
 * `scanFn` is injectable for tests; production uses the real engine.
 */
export async function runScan(
  text: string,
  provider: string | undefined,
  transport: Transport,
  deps: { scanFn?: typeof scan; fetchImpl?: typeof fetch } = {},
): Promise<ScanResult> {
  if (transport.mode === 'hosted') {
    return hostedScan(text, provider, transport, deps.fetchImpl ?? fetch);
  }
  return (deps.scanFn ?? scan)(text, provider);
}

/**
 * Whether verification on this configuration retrieves live sources.
 *
 * Only the gemini path calls a search tool during verify
 * (services/geminiService.ts:172 `tools: [{ googleSearch: {} }]`). Every other
 * provider judges from the model's own knowledge and returns verdicts with no
 * evidence behind them — a distinction invisible in the verdict itself, so it
 * has to be reported alongside.
 *
 * With no provider named, both transports default to gemini (the API route
 * applies `provider ?? 'gemini'` server-side), so the default is grounded.
 */
export function isGrounded(provider?: string): boolean {
  const p = (provider ?? '').trim().toLowerCase();
  if (!p) return true;
  return p.includes('gemini');
}
