/**
 * Keys management HTTP client for the Faultline CLI.
 * Talks to the Faultline API server's /keys endpoints.
 */

export interface KeyEntry {
  id: string;
  name: string;
  permissions: string[];
  createdAt: string;
  disabled?: boolean;
  lastUsedAt?: string;
  lastRotatedAt?: string;
  expiresAt?: string;
}

export interface KeysListResult {
  keys: KeyEntry[];
  error?: string;
}

export interface DormantResult {
  days: number;
  count: number;
  keys: KeyEntry[];
  error?: string;
}

export interface ExpiringSoonResult {
  days: number;
  count: number;
  keys: KeyEntry[];
  error?: string;
}

export interface RotateResult {
  id: string;
  newKey: string;
  previousKey: string;
  previousKeyExpiresAt: string;
  gracePeriodHours: number;
  message: string;
  error?: string;
}

async function apiFetch(url: string, apiKey: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `HTTP ${res.status}`;
    return { error: msg };
  }
  return body;
}

export async function listKeys(apiUrl: string, apiKey: string): Promise<KeysListResult> {
  const result = await apiFetch(`${apiUrl}/keys`, apiKey);
  if ((result as { error?: string }).error) return { keys: [], error: (result as { error: string }).error };
  return { keys: result as KeyEntry[] };
}

export async function getDormantKeys(apiUrl: string, apiKey: string, days: number): Promise<DormantResult> {
  const result = await apiFetch(`${apiUrl}/keys/dormant?days=${days}`, apiKey);
  if ((result as { error?: string }).error) return { days, count: 0, keys: [], error: (result as { error: string }).error };
  return result as DormantResult;
}

export async function getExpiringSoonKeys(apiUrl: string, apiKey: string, days: number): Promise<ExpiringSoonResult> {
  const result = await apiFetch(`${apiUrl}/keys/expiring-soon?days=${days}`, apiKey);
  if ((result as { error?: string }).error) return { days, count: 0, keys: [], error: (result as { error: string }).error };
  return result as ExpiringSoonResult;
}

export async function rotateKey(apiUrl: string, apiKey: string, id: string): Promise<RotateResult> {
  const result = await apiFetch(`${apiUrl}/keys/${id}/rotate`, apiKey, { method: 'POST' });
  return result as RotateResult;
}

// ── Formatters ───────────────────────────────────────────────────────────────

export function formatKeyList(keys: KeyEntry[]): string {
  if (keys.length === 0) return 'No API keys found.';
  const lines = [`API Keys (${keys.length}):`, ''];
  for (const k of keys) {
    const tags: string[] = [];
    if (k.disabled) tags.push('DISABLED');
    if (k.expiresAt && new Date(k.expiresAt) < new Date()) tags.push('EXPIRED');
    const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
    lines.push(`  ${k.id.slice(0, 8)}  ${k.name.padEnd(24)}${tagStr}`);
    lines.push(`           permissions: ${k.permissions.join(', ')}`);
    lines.push(`           created:     ${k.createdAt.slice(0, 10)}`);
    if (k.lastUsedAt) lines.push(`           last used:   ${k.lastUsedAt.slice(0, 10)}`);
    if (k.expiresAt) lines.push(`           expires:     ${k.expiresAt.slice(0, 10)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatDormantList(result: DormantResult): string {
  if (result.count === 0) return `No dormant keys found (threshold: ${result.days} days).`;
  const lines = [`Dormant keys — unused for >${result.days} days (${result.count}):`, ''];
  for (const k of result.keys) {
    const ref = k.lastUsedAt ?? k.createdAt;
    const daysSince = Math.floor((Date.now() - new Date(ref).getTime()) / 86_400_000);
    lines.push(`  ${k.id.slice(0, 8)}  ${k.name.padEnd(24)}  ${daysSince}d since last use`);
  }
  return lines.join('\n');
}

export function formatExpiringSoonList(result: ExpiringSoonResult): string {
  if (result.count === 0) return `No keys expiring within ${result.days} days.`;
  const lines = [`Keys expiring within ${result.days} days (${result.count}):`, ''];
  for (const k of result.keys) {
    const hoursLeft = Math.floor((new Date(k.expiresAt!).getTime() - Date.now()) / 3_600_000);
    const urgency = hoursLeft < 24 ? ' [URGENT]' : '';
    lines.push(`  ${k.id.slice(0, 8)}  ${k.name.padEnd(24)}  expires ${k.expiresAt!.slice(0, 10)} (${hoursLeft}h)${urgency}`);
  }
  return lines.join('\n');
}

export function formatRotateResult(result: RotateResult): string {
  if (result.error) return `Error: ${result.error}`;
  return [
    `Key rotated successfully.`,
    ``,
    `  New key:              ${result.newKey}`,
    `  Previous key valid until: ${result.previousKeyExpiresAt}`,
    `  Grace period:         ${result.gracePeriodHours} hours`,
    ``,
    `Store the new key securely — it will not be shown again.`,
  ].join('\n');
}
