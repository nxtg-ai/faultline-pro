import { mayIssueKey, CUSTOMER_KEYS_CLOSED } from '../lib/key-issuance.js';
import { getAuditLogger } from '../store/audit.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hasScope, isAdminKeyId, requireAdmin } from '../plugins/auth.js';
import { esc } from '../lib/html.js';
import { getKeyStore, KEY_SCOPES, MAX_KEY_IDEMPOTENCY_KEY_LENGTH, ROTATION_GRACE_HOURS } from '../store/keys.js';
import type { ApiKey, KeyScope, Permission } from '../store/keys.js';
import { getNotificationStore } from '../store/notifications.js';

const VALID_PERMISSIONS: Permission[] = ['scan', 'report', 'upload', 'admin', 'pro'];

/** Claims per calendar month (UTC) a metered key may have verified. */
const CLAIM_CAP_SCHEMA = { type: 'integer', minimum: 0, maximum: 100_000_000 } as const;
/** A Stripe customer id (`cus_...`). Format-checked so no free text reaches the usage record. */
const STRIPE_CUSTOMER_SCHEMA = { type: 'string', pattern: '^cus_[A-Za-z0-9]{1,64}$' } as const;
const METERED_SCHEMA = { type: 'boolean' } as const;
const SCOPES_SCHEMA = { type: 'array', uniqueItems: true, items: { type: 'string', enum: [...KEY_SCOPES] } } as const;

/** The key fields that bind a key to billing. Setting any of them needs scope keys:write. */
const BILLING_FIELDS = ['claimCap', 'stripeCustomerId', 'metered', 'scopes'] as const;

/**
 * Why this caller may not set the billing fields in `body`, or null when it
 * may. Setting any of them needs scope `keys:write`; granting scopes needs an
 * admin key. Both routes are admin-only today and admin keys pass every scope,
 * so these checks hold the rule in place if the routes are ever opened wider.
 */
function billingFieldRefusal(keyId: string | undefined, body: Record<string, unknown>): { error: string; scope?: KeyScope } | null {
  if (!BILLING_FIELDS.some((f) => body[f] !== undefined)) return null;
  if (!hasScope(keyId, 'keys:write')) return { error: 'scope_required', scope: 'keys:write' };
  if (body.scopes !== undefined && !isAdminKeyId(keyId)) return { error: 'admin_required' };
  return null;
}

/** undefined = header absent; null = present but empty or longer than 200 characters. */
function readIdempotencyKey(request: FastifyRequest): string | null | undefined {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  return value.length === 0 || value.length > MAX_KEY_IDEMPOTENCY_KEY_LENGTH ? null : value;
}

/** A key as a replayed POST /keys returns it: never the plaintext again. */
function replayView(keyId: string, entry: ApiKey | null): Record<string, unknown> {
  if (!entry) return { id: keyId, key: null };
  const { key: _key, previousKey: _prev, ...rest } = entry;
  return { ...rest, key: null };
}

const CREATE_BODY_SCHEMA = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    permissions: {
      type: 'array',
      items: { type: 'string', enum: VALID_PERMISSIONS },
    },
    expiresAt: { type: 'string', format: 'date-time' },
    claimCap: CLAIM_CAP_SCHEMA,
    stripeCustomerId: STRIPE_CUSTOMER_SCHEMA,
    metered: METERED_SCHEMA,
    scopes: SCOPES_SCHEMA,
  },
  additionalProperties: false,
} as const;

interface CreateKeyBody {
  name: string;
  permissions?: Permission[];
  expiresAt?: string;
  claimCap?: number;
  stripeCustomerId?: string;
  metered?: boolean;
  scopes?: KeyScope[];
}

export async function keysRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CreateKeyBody }>(
    '/keys',
    { config: { access: 'admin' }, preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Create a new API key (Idempotency-Key optional)', body: CREATE_BODY_SCHEMA } },
    async (request, reply) => {
      const { name, permissions, expiresAt, claimCap, stripeCustomerId, metered, scopes } = request.body;
      const idempotencyKey = readIdempotencyKey(request);
      if (idempotencyKey === null) return reply.status(400).send({ error: 'idempotency_key_invalid' });
      const store = getKeyStore();
      // No await from the lookup to remember: a concurrent replay cannot mint a second key.
      if (idempotencyKey !== undefined) {
        const prior = store.keyIdForIdempotencyKey(idempotencyKey);
        if (prior !== undefined) return reply.status(200).send(replayView(prior, store.validateById(prior)));
      }
      const refusal = billingFieldRefusal(request.keyId, request.body as unknown as Record<string, unknown>);
      if (refusal) return reply.status(403).send(refusal);
      if (!mayIssueKey(permissions)) return reply.status(403).send(CUSTOMER_KEYS_CLOSED);
      const entry = store.create(name, permissions, expiresAt, { claimCap, stripeCustomerId, metered, scopes });
      if (idempotencyKey !== undefined) store.rememberIdempotencyKey(idempotencyKey, entry.id);
      return reply.status(201).send(entry);
    },
  );

  fastify.get('/keys', { config: { access: 'admin' }, preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'List all API keys (secrets redacted)' } }, async (_request, reply) => {
    const store = getKeyStore();
    const keys = store.list().map(({ key: _key, previousKey: _prev, ...rest }) => rest);
    return reply.status(200).send(keys);
  });

  fastify.get<{ Querystring: { dormantDays?: string; expiringSoonDays?: string } }>(
    '/keys/usage',
    {
      config: { access: 'admin' },
      preHandler: requireAdmin,
      schema: {
        tags: ['Keys'],
        summary: 'Per-key usage analytics — hygiene stats (dormant, expiring-soon, expired, disabled) with summary counts.',
        querystring: {
          type: 'object',
          properties: {
            dormantDays:      { type: 'string', pattern: '^[0-9]+$' },
            expiringSoonDays: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request, reply) => {
      const dormantDays      = Math.min(365, Math.max(1, parseInt(request.query.dormantDays      ?? '30', 10)));
      const expiringSoonDays = Math.min(365, Math.max(1, parseInt(request.query.expiringSoonDays ?? '7',  10)));
      const store = getKeyStore();
      const keys  = store.getUsageStats(dormantDays, expiringSoonDays);

      const summary = {
        total:            keys.length,
        dormantCount:     keys.filter((k) => k.isDormant).length,
        expiringSoonCount: keys.filter((k) => k.isExpiringSoon).length,
        expiredCount:     keys.filter((k) => k.isExpired).length,
        disabledCount:    keys.filter((k) => k.disabled).length,
      };

      return reply.status(200).send({ ...summary, keys });
    },
  );

  fastify.get<{ Querystring: { dormantDays?: string; expiringSoonDays?: string } }>(
    '/keys/usage/view',
    {
      config: { access: 'admin' },
      preHandler: requireAdmin,
      schema: { tags: ['Keys'], summary: 'Key hygiene dashboard (HTML)' },
    },
    async (request, reply) => {
      const dormantDays      = Math.min(365, Math.max(1, parseInt(request.query.dormantDays      ?? '30', 10)));
      const expiringSoonDays = Math.min(365, Math.max(1, parseInt(request.query.expiringSoonDays ?? '7',  10)));
      const store = getKeyStore();
      const keys  = store.getUsageStats(dormantDays, expiringSoonDays);

      const total            = keys.length;
      const dormantCount     = keys.filter((k) => k.isDormant).length;
      const expiringSoonCount = keys.filter((k) => k.isExpiringSoon).length;
      const expiredCount     = keys.filter((k) => k.isExpired).length;
      const disabledCount    = keys.filter((k) => k.disabled).length;

      const badge = (label: string, count: number, colour: string) =>
        `<div style="background:${colour};border-radius:8px;padding:16px 24px;min-width:100px;text-align:center;">
          <div style="font-size:2em;font-weight:700;">${count}</div>
          <div style="font-size:.85em;opacity:.85;">${label}</div>
        </div>`;

      const statusChip = (k: (typeof keys)[0]) => {
        if (k.isExpired)     return '<span style="background:#dc2626;color:#fff;border-radius:4px;padding:2px 6px;font-size:.75em;">EXPIRED</span>';
        if (k.disabled)      return '<span style="background:#6b7280;color:#fff;border-radius:4px;padding:2px 6px;font-size:.75em;">DISABLED</span>';
        if (k.isExpiringSoon) return '<span style="background:#d97706;color:#fff;border-radius:4px;padding:2px 6px;font-size:.75em;">EXPIRING SOON</span>';
        if (k.isDormant)     return '<span style="background:#ca8a04;color:#fff;border-radius:4px;padding:2px 6px;font-size:.75em;">DORMANT</span>';
        return '<span style="background:#16a34a;color:#fff;border-radius:4px;padding:2px 6px;font-size:.75em;">HEALTHY</span>';
      };

      const rows = keys.length === 0
        ? '<tr><td colspan="7" style="text-align:center;padding:32px;color:#9ca3af;">No API keys found.</td></tr>'
        : keys.map((k) => `
          <tr style="border-bottom:1px solid #1f2937;">
            <td style="padding:10px 12px;font-family:monospace;font-size:.85em;">${esc(k.id.slice(0, 8))}</td>
            <td style="padding:10px 12px;">${esc(k.name)}</td>
            <td style="padding:10px 12px;">${statusChip(k)}</td>
            <td style="padding:10px 12px;color:#9ca3af;font-size:.85em;">${k.daysSinceLastUse !== null ? `${esc(k.daysSinceLastUse)}d ago` : '—'}</td>
            <td style="padding:10px 12px;color:#9ca3af;font-size:.85em;">${k.daysSinceLastRotation !== null ? `${esc(k.daysSinceLastRotation)}d ago` : '—'}</td>
            <td style="padding:10px 12px;color:#9ca3af;font-size:.85em;">${k.expiresAt ? esc(k.expiresAt.slice(0, 10)) : '—'}</td>
            <td style="padding:10px 12px;color:#9ca3af;font-size:.85em;">${esc(k.permissions.join(', '))}</td>
          </tr>`).join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>Key Hygiene — Faultline</title>
  <style>
    body{margin:0;background:#0f172a;color:#f1f5f9;font-family:system-ui,sans-serif;}
    h1{margin:0;font-size:1.4em;font-weight:700;}
    table{width:100%;border-collapse:collapse;}
    th{text-align:left;padding:8px 12px;font-size:.75em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #1f2937;}
    tr:hover td{background:#1e293b;}
  </style>
</head>
<body>
  <div style="padding:24px 32px;border-bottom:1px solid #1f2937;display:flex;align-items:center;justify-content:space-between;">
    <h1>🔑 Key Hygiene Dashboard</h1>
    <span style="color:#64748b;font-size:.85em;">dormant≥${dormantDays}d · expiring≤${expiringSoonDays}d · auto-refresh 60s</span>
  </div>
  <div style="padding:24px 32px;">
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:32px;">
      ${badge('Total', total, '#1e293b')}
      ${badge('Dormant', dormantCount, '#78350f')}
      ${badge('Expiring Soon', expiringSoonCount, '#7c2d12')}
      ${badge('Expired', expiredCount, '#7f1d1d')}
      ${badge('Disabled', disabledCount, '#374151')}
    </div>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Name</th><th>Status</th>
          <th>Last Used</th><th>Last Rotated</th><th>Expires</th><th>Permissions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`;

      return reply.status(200).header('content-type', 'text/html; charset=utf-8').send(html);
    },
  );

  fastify.get<{ Querystring: { days?: string } }>(
    '/keys/dormant',
    {
      config: { access: 'admin' },
      preHandler: requireAdmin,
      schema: {
        tags: ['Keys'],
        summary: 'List keys dormant for ≥N days (default 30). A key is dormant when lastUsedAt (or createdAt if never used) is older than the threshold.',
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request, reply) => {
      const days = Math.min(365, Math.max(1, parseInt(request.query.days ?? '30', 10)));
      const store = getKeyStore();
      const keys = store.getDormant(days).map(({ key: _key, previousKey: _prev, ...rest }) => rest);
      return reply.status(200).send({ days, count: keys.length, keys });
    },
  );

  fastify.get<{ Querystring: { days?: string } }>(
    '/keys/expiring-soon',
    {
      config: { access: 'admin' },
      preHandler: requireAdmin,
      schema: {
        tags: ['Keys'],
        summary: 'List keys expiring within N days (default 7). Excludes permanent keys and already-expired keys.',
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request, reply) => {
      const days = Math.min(365, Math.max(1, parseInt(request.query.days ?? '7', 10)));
      const store = getKeyStore();
      const keys = store.getExpiringSoon(days).map(({ key: _key, previousKey: _prev, ...rest }) => rest);
      return reply.status(200).send({ days, count: keys.length, keys });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/keys/:id',
    { config: { access: 'admin' }, preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Get a single API key by ID (secret redacted)' } },
    async (request, reply) => {
      const store = getKeyStore();
      const entry = store.validateById(request.params.id);
      if (!entry) return reply.status(404).send({ error: 'Key not found.' });
      const { key: _key, previousKey: _prev, ...rest } = entry;
      return reply.status(200).send(rest);
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/keys/:id',
    { config: { access: 'admin' }, preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Delete an API key by ID' } },
    async (request, reply) => {
      const store = getKeyStore();
      const deleted = store.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Key not found.' });
      }
      return reply.status(204).send();
    },
  );

  // ── Bulk delete ────────────────────────────────────────────────────────────

  const BULK_DELETE_BODY_SCHEMA = {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 365 },
      ids:  { type: 'array', items: { type: 'string' }, maxItems: 500 },
    },
    additionalProperties: false,
  } as const;

  interface BulkDeleteBody {
    days?: number;
    ids?:  string[];
  }

  fastify.post<{ Body: BulkDeleteBody }>(
    '/keys/bulk-delete',
    {
      config: { access: 'admin' },
      preHandler: requireAdmin,
      schema: {
        tags: ['Keys'],
        summary: 'Bulk-delete keys. Provide ids[] to delete specific keys, or days to delete all dormant keys (unused for ≥N days). Both fields may be combined.',
        body: BULK_DELETE_BODY_SCHEMA,
      },
    },
    async (request, reply) => {
      const store = getKeyStore();
      const { days, ids = [] } = request.body;

      // Collect IDs to delete: explicit list + dormant keys older than `days`
      const targets = new Set<string>(ids);
      if (days !== undefined) {
        for (const k of store.getDormant(days)) targets.add(k.id);
      }

      if (targets.size === 0) {
        return reply.status(200).send({ deleted: 0, ids: [] });
      }

      const deleted = store.bulkDelete(Array.from(targets));
      return reply.status(200).send({ deleted: deleted.length, ids: deleted });
    },
  );

  /**
   * Reviving a key (re-enabling it, or changing or clearing its expiry) is an
   * admin action and leaves an audit row naming the key and how, so a key a
   * customer lost cannot come back unseen (emma-soul ruling Dx3 e2909e46, item 3).
   */
  function auditRevival(request: FastifyRequest, keyIds: string[], how: string): void {
    for (const id of keyIds) {
      getAuditLogger().log({
        timestamp: new Date().toISOString(),
        keyId: request.keyId ?? 'unknown',
        endpoint: '/keys/revival',
        method: request.method,
        statusCode: 200,
        latencyMs: 0,
        note: `key revived: ${id} (${how})`,
      });
    }
  }

  // ── Bulk disable / enable ──────────────────────────────────────────────────

  const BULK_DISABLE_BODY_SCHEMA = {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 365 },
      ids:  { type: 'array', items: { type: 'string' }, maxItems: 500 },
    },
    additionalProperties: false,
  } as const;

  interface BulkDisableBody {
    days?: number;
    ids?:  string[];
  }

  fastify.post<{ Body: BulkDisableBody }>(
    '/keys/bulk-disable',
    {
      config: { access: 'admin' },
      preHandler: requireAdmin,
      schema: {
        tags: ['Keys'],
        summary: 'Bulk-disable keys. Provide ids[] to disable specific keys, or days to disable all dormant keys (unused for ≥N days). Both fields may be combined.',
        body: BULK_DISABLE_BODY_SCHEMA,
      },
    },
    async (request, reply) => {
      const store = getKeyStore();
      const { days, ids = [] } = request.body;

      const targets = new Set<string>(ids);
      if (days !== undefined) {
        for (const k of store.getDormant(days)) targets.add(k.id);
      }

      if (targets.size === 0) {
        return reply.status(200).send({ disabled: 0, ids: [] });
      }

      const changed = store.bulkDisable(Array.from(targets));
      return reply.status(200).send({ disabled: changed.length, ids: changed });
    },
  );

  const BULK_ENABLE_BODY_SCHEMA = {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, maxItems: 500 },
    },
    required: ['ids'],
    additionalProperties: false,
  } as const;

  interface BulkEnableBody {
    ids: string[];
  }

  fastify.post<{ Body: BulkEnableBody }>(
    '/keys/bulk-enable',
    {
      config: { access: 'admin' },
      preHandler: requireAdmin,
      schema: {
        tags: ['Keys'],
        summary: 'Bulk-enable previously disabled keys by ID.',
        body: BULK_ENABLE_BODY_SCHEMA,
      },
    },
    async (request, reply) => {
      const store = getKeyStore();
      const { ids } = request.body;

      if (ids.length === 0) {
        return reply.status(200).send({ enabled: 0, ids: [] });
      }

      const changed = store.bulkEnable(ids);
      auditRevival(request, changed, 'bulk-enable');
      return reply.status(200).send({ enabled: changed.length, ids: changed });
    },
  );

  // ── Partial update ─────────────────────────────────────────────────────────

  const PATCH_BODY_SCHEMA = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      permissions: {
        type: 'array',
        items: { type: 'string', enum: VALID_PERMISSIONS },
      },
      expiresAt: { type: ['string', 'null'] },
      claimCap: { ...CLAIM_CAP_SCHEMA, type: ['integer', 'null'] },
      stripeCustomerId: { ...STRIPE_CUSTOMER_SCHEMA, type: ['string', 'null'] },
      metered: METERED_SCHEMA,
      scopes: SCOPES_SCHEMA,
    },
    additionalProperties: false,
  } as const;

  interface PatchKeyBody {
    name?: string;
    permissions?: Permission[];
    expiresAt?: string | null;
    claimCap?: number | null;
    stripeCustomerId?: string | null;
    metered?: boolean;
    scopes?: KeyScope[];
  }

  fastify.patch<{ Params: { id: string }; Body: PatchKeyBody }>(
    '/keys/:id',
    { config: { access: 'admin' }, preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Update key name and/or permissions', body: PATCH_BODY_SCHEMA } },
    async (request, reply) => {
      // Re-scoping a key is issuing one: an admin key PATCHed down to ["scan"]
      // would be a customer key minted past the freeze (seat al:cb6b01db985c2056 M1).
      if (request.body.permissions !== undefined && !mayIssueKey(request.body.permissions)) {
        return reply.status(403).send(CUSTOMER_KEYS_CLOSED);
      }
      const refusal = billingFieldRefusal(request.keyId, request.body as unknown as Record<string, unknown>);
      if (refusal) return reply.status(403).send(refusal);
      const store = getKeyStore();
      const updated = store.update(request.params.id, request.body);
      if (!updated) return reply.status(404).send({ error: 'Key not found.' });
      if (request.body.expiresAt !== undefined) {
        auditRevival(request, [updated.id], request.body.expiresAt === null ? 'expiresAt cleared' : `expiresAt set to ${request.body.expiresAt}`);
      }
      const { key: _key, previousKey: _prev, ...rest } = updated;
      return reply.status(200).send(rest);
    },
  );

  // ── Rotation ───────────────────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    '/keys/:id/rotate',
    {
      config: { access: 'admin' },
      preHandler: requireAdmin,
      schema: {
        tags: ['Keys'],
        summary: 'Rotate an API key — generates new key, old key valid for 24h grace period',
        description: [
          'Generates a cryptographically random replacement key.',
          'The previous key continues to be accepted for ' + ROTATION_GRACE_HOURS + ' hours',
          'to allow zero-downtime rotation without co-ordinating deployment restarts.',
          '',
          'The new key is returned **once** in this response — store it securely.',
          'The previous key value is also returned once so the caller knows what to replace.',
          '',
          'A subscription.changed notification is dispatched to any subscribers on this key.',
        ].join('\n'),
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const store = getKeyStore();
      const result = store.rotate(request.params.id);

      if (!result) {
        return reply.status(404).send({ error: 'Key not found.' });
      }

      // Dispatch notification (non-blocking — rotation succeeds regardless)
      void getNotificationStore().dispatch(
        'subscription.changed',
        {
          keyId:                result.id,
          change:               'key_rotated',
          previousKeyExpiresAt: result.previousKeyExpiresAt,
          gracePeriodHours:     result.gracePeriodHours,
          message:              `API key rotated. Previous key valid until ${result.previousKeyExpiresAt}.`,
        },
        result.id,
      ).catch(() => undefined);

      return reply.status(200).send({
        id:                   result.id,
        newKey:               result.newKey,
        previousKey:          result.previousKey,
        previousKeyExpiresAt: result.previousKeyExpiresAt,
        gracePeriodHours:     result.gracePeriodHours,
        message:              `New key generated. Your previous key remains valid for ${result.gracePeriodHours} hours (until ${result.previousKeyExpiresAt}). Store the new key securely — it will not be shown again.`,
      });
    },
  );

  // ── Disable / Enable ───────────────────────────────────────────────────────

  fastify.patch<{ Params: { id: string } }>(
    '/keys/:id/disable',
    { config: { access: 'admin' }, preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Disable an API key — rejects auth without deleting the key' } },
    async (request, reply) => {
      const store = getKeyStore();
      const ok = store.disable(request.params.id);
      if (!ok) return reply.status(404).send({ error: 'Key not found.' });
      const entry = store.validateById(request.params.id);
      return reply.status(200).send({ id: entry!.id, name: entry!.name, disabled: true });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/keys/:id/enable',
    { config: { access: 'admin' }, preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Re-enable a previously disabled API key' } },
    async (request, reply) => {
      const store = getKeyStore();
      const ok = store.enable(request.params.id);
      if (!ok) return reply.status(404).send({ error: 'Key not found.' });
      auditRevival(request, [request.params.id], 'enable');
      const entry = store.validateById(request.params.id);
      return reply.status(200).send({ id: entry!.id, name: entry!.name, disabled: false });
    },
  );

  // GET /keys/:id/rotation-status — check grace period status for a key
  fastify.get<{ Params: { id: string } }>(
    '/keys/:id/rotation-status',
    {
      config: { access: 'admin' },
      preHandler: requireAdmin,
      schema: {
        tags: ['Keys'],
        summary: 'Check rotation/grace-period status for a key',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const store = getKeyStore();
      const entry = store.validateById(request.params.id);
      if (!entry) return reply.status(404).send({ error: 'Key not found.' });

      const inGrace = store.isInGracePeriod(request.params.id);
      return reply.send({
        id:                   entry.id,
        name:                 entry.name,
        lastRotatedAt:        entry.lastRotatedAt ?? null,
        inGracePeriod:        inGrace,
        previousKeyExpiresAt: entry.previousKeyExpiresAt ?? null,
        gracePeriodHours:     ROTATION_GRACE_HOURS,
      });
    },
  );
}
