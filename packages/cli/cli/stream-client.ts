/**
 * N-136 — faultline stream CLI command.
 * HTTP client for GET /scan/stream and output formatter.
 */

export interface StreamEvent {
  type: 'start' | 'claim_verified' | 'complete' | 'error';
  // start
  claimCount?: number;
  provider?: string;
  // claim_verified
  index?: number;
  claim?: Record<string, unknown>;
  verdict?: Record<string, unknown> | null;
  // complete
  overallRisk?: string;
  // error
  message?: string;
}

export interface StreamResult {
  events: StreamEvent[];
  overallRisk?: string;
  claimCount?: number;
  provider?: string;
  error?: string;
}

/** Parse a raw SSE response body into typed StreamEvent objects. */
export function parseSSEBody(body: string): StreamEvent[] {
  return body
    .split('\n\n')
    .filter(chunk => chunk.startsWith('data: '))
    .map(chunk => {
      try {
        return JSON.parse(chunk.replace(/^data: /, '')) as StreamEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is StreamEvent => e !== null);
}

/**
 * Call GET /scan/stream and return parsed events.
 * Uses text-only fetch — no streaming reader needed (mock provider is fast).
 */
export async function streamScan(
  apiUrl: string,
  apiKey: string,
  text: string,
  provider = 'mock',
): Promise<StreamResult> {
  const url = `${apiUrl}/scan/stream?text=${encodeURIComponent(text)}&provider=${encodeURIComponent(provider)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'x-api-key': apiKey } });
  } catch (err) {
    return { events: [], error: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* ignore */ }
    return { events: [], error: msg };
  }

  const body = await res.text();
  const events = parseSSEBody(body);

  const start    = events.find(e => e.type === 'start');
  const complete = events.find(e => e.type === 'complete');
  const errEvent = events.find(e => e.type === 'error');

  if (errEvent) {
    return { events, error: errEvent.message };
  }

  return {
    events,
    overallRisk: complete?.overallRisk,
    claimCount:  start?.claimCount ?? complete?.claimCount,
    provider:    start?.provider ?? provider,
  };
}

const VERDICT_ICONS: Record<string, string> = {
  supported:    '✓',
  contradicted: '✗',
  mixed:        '~',
  unverified:   '?',
};

/** Render a stream result as human-readable CLI output. */
export function formatStreamResult(result: StreamResult): string {
  if (result.error) {
    return `Error: ${result.error}`;
  }

  const lines: string[] = [];
  const provider = result.provider ?? 'unknown';
  const claimCount = result.claimCount ?? 0;

  lines.push(`Scanning via ${provider} provider…`);
  lines.push('');

  const claimEvents = result.events.filter(e => e.type === 'claim_verified');

  if (claimEvents.length === 0) {
    lines.push('No claims found.');
  } else {
    for (const ev of claimEvents) {
      const idx     = (ev.index ?? 0) + 1;
      const text    = (ev.claim?.['text'] as string | undefined) ?? '(unknown claim)';
      const preview = text.length > 80 ? text.slice(0, 77) + '...' : text;
      const status  = (ev.verdict?.['status'] as string | undefined) ?? 'unverified';
      const icon    = VERDICT_ICONS[status] ?? '?';
      lines.push(`  Claim ${idx} ${icon} ${status}: "${preview}"`);
    }
  }

  lines.push('');

  const risk = result.overallRisk ?? 'unknown';
  lines.push(`Risk: ${risk.toUpperCase()}`);
  lines.push(`Claims verified: ${claimCount}`);

  return lines.join('\n');
}
