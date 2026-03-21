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

// ── Rotation status ───────────────────────────────────────────────────────────

export interface RotationStat {
  id: string;
  name: string;
  lastRotatedAt: string | null;
  createdAt: string;
  daysSinceLastRotation: number | null;
  disabled: boolean;
  isExpired: boolean;
}

export interface RotationStatusResult {
  days: number;
  overdueCount: number;
  criticalCount: number;
  keys: RotationStat[];
  error?: string;
}

interface UsageStat {
  id: string;
  name: string;
  createdAt: string;
  lastRotatedAt: string | null;
  daysSinceLastRotation: number | null;
  disabled: boolean;
  isExpired: boolean;
}

interface UsageResponse {
  keys: UsageStat[];
  error?: string;
}

export async function getRotationStatus(apiUrl: string, apiKey: string, days: number): Promise<RotationStatusResult> {
  const result = await apiFetch(`${apiUrl}/keys/usage?dormantDays=1&expiringSoonDays=1`, apiKey);
  if ((result as { error?: string }).error) {
    return { days, overdueCount: 0, criticalCount: 0, keys: [], error: (result as { error: string }).error };
  }
  const { keys } = result as UsageResponse;
  // Filter to keys where rotation age >= days threshold; null means never rotated (use createdAt age)
  const filtered: RotationStat[] = (keys ?? [])
    .map((k) => ({
      id:                   k.id,
      name:                 k.name,
      lastRotatedAt:        k.lastRotatedAt,
      createdAt:            k.createdAt,
      daysSinceLastRotation: k.daysSinceLastRotation,
      disabled:             k.disabled,
      isExpired:            k.isExpired,
    }))
    .filter((k) => {
      // daysSinceLastRotation is null when never rotated — treat as age since creation
      const age = k.daysSinceLastRotation ??
        Math.floor((Date.now() - new Date(k.createdAt).getTime()) / 86_400_000);
      return age >= days;
    })
    .sort((a, b) => {
      const ageA = a.daysSinceLastRotation ?? Math.floor((Date.now() - new Date(a.createdAt).getTime()) / 86_400_000);
      const ageB = b.daysSinceLastRotation ?? Math.floor((Date.now() - new Date(b.createdAt).getTime()) / 86_400_000);
      return ageB - ageA; // oldest-first
    });

  const overdueCount   = filtered.filter((k) => {
    const age = k.daysSinceLastRotation ?? Math.floor((Date.now() - new Date(k.createdAt).getTime()) / 86_400_000);
    return age >= 90;
  }).length;
  const criticalCount  = filtered.filter((k) => {
    const age = k.daysSinceLastRotation ?? Math.floor((Date.now() - new Date(k.createdAt).getTime()) / 86_400_000);
    return age >= 180;
  }).length;

  return { days, overdueCount, criticalCount, keys: filtered };
}

export function formatRotationStatus(result: RotationStatusResult): string {
  if (result.error) return `Error: ${result.error}`;
  if (result.keys.length === 0) {
    return `All keys rotated within the last ${result.days} days.`;
  }
  const lines = [
    `Keys overdue for rotation (>${result.days}d): ${result.keys.length}  [OVERDUE: ${result.overdueCount}  CRITICAL: ${result.criticalCount}]`,
    '',
  ];
  for (const k of result.keys) {
    const age = k.daysSinceLastRotation ??
      Math.floor((Date.now() - new Date(k.createdAt).getTime()) / 86_400_000);
    const chip  = age >= 180 ? ' [CRITICAL]' : ' [OVERDUE]';
    const ref   = k.lastRotatedAt ? `last rotated ${k.lastRotatedAt.slice(0, 10)}` : `created ${k.createdAt.slice(0, 10)}, never rotated`;
    const extra: string[] = [];
    if (k.disabled)  extra.push('DISABLED');
    if (k.isExpired) extra.push('EXPIRED');
    const tagStr = extra.length ? `  [${extra.join(', ')}]` : '';
    lines.push(`  ${k.id.slice(0, 8)}  ${k.name.padEnd(24)}  ${age}d${chip}  ${ref}${tagStr}`);
  }
  return lines.join('\n');
}

// ── Prune (bulk-delete dormant) ───────────────────────────────────────────────

export interface PrunePreviewResult {
  days: number;
  count: number;
  keys: KeyEntry[];
  error?: string;
}

export interface PruneResult {
  days: number;
  deleted: number;
  ids: string[];
  error?: string;
}

/** Preview: fetches dormant keys that WOULD be deleted (dry-run). */
export async function getKeysPrunePreview(apiUrl: string, apiKey: string, days: number): Promise<PrunePreviewResult> {
  const result = await apiFetch(`${apiUrl}/keys/dormant?days=${days}`, apiKey);
  if ((result as { error?: string }).error) {
    return { days, count: 0, keys: [], error: (result as { error: string }).error };
  }
  return result as PrunePreviewResult;
}

/** Execute: calls POST /keys/bulk-delete with { days } to actually delete dormant keys. */
export async function pruneKeys(apiUrl: string, apiKey: string, days: number): Promise<PruneResult> {
  const result = await apiFetch(`${apiUrl}/keys/bulk-delete`, apiKey, {
    method: 'POST',
    body: JSON.stringify({ days }),
  });
  if ((result as { error?: string }).error) {
    return { days, deleted: 0, ids: [], error: (result as { error: string }).error };
  }
  const { deleted, ids } = result as { deleted: number; ids: string[] };
  return { days, deleted, ids };
}

export function formatPrunePreview(result: PrunePreviewResult): string {
  if (result.error) return `Error: ${result.error}`;
  if (result.count === 0) {
    return `No dormant keys found (threshold: ${result.days} days). Nothing to prune.`;
  }
  const lines = [
    `DRY RUN — would delete ${result.count} dormant key${result.count === 1 ? '' : 's'} (unused for >${result.days} days):`,
    '',
  ];
  for (const k of result.keys) {
    const ref      = k.lastUsedAt ?? k.createdAt;
    const daysSince = Math.floor((Date.now() - new Date(ref).getTime()) / 86_400_000);
    lines.push(`  ${k.id.slice(0, 8)}  ${k.name.padEnd(24)}  ${daysSince}d since last use`);
  }
  lines.push('');
  lines.push(`Run with --confirm to permanently delete these keys.`);
  return lines.join('\n');
}

export function formatPruneResult(result: PruneResult): string {
  if (result.error) return `Error: ${result.error}`;
  if (result.deleted === 0) {
    return `No dormant keys found (threshold: ${result.days} days). Nothing pruned.`;
  }
  const lines = [
    `Pruned ${result.deleted} dormant key${result.deleted === 1 ? '' : 's'} (unused for >${result.days} days).`,
    '',
  ];
  for (const id of result.ids) {
    lines.push(`  ${id.slice(0, 8)}`);
  }
  return lines.join('\n');
}
