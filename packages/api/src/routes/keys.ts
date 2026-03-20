import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { getKeyStore, ROTATION_GRACE_HOURS } from '../store/keys.js';
import type { Permission } from '../store/keys.js';
import { getNotificationStore } from '../store/notifications.js';

const VALID_PERMISSIONS: Permission[] = ['scan', 'report', 'upload', 'admin', 'pro'];

const CREATE_BODY_SCHEMA = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    permissions: {
      type: 'array',
      items: { type: 'string', enum: VALID_PERMISSIONS },
    },
  },
  additionalProperties: false,
} as const;

interface CreateKeyBody {
  name: string;
  permissions?: Permission[];
}

export async function keysRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CreateKeyBody }>(
    '/keys',
    { preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Create a new API key', body: CREATE_BODY_SCHEMA } },
    async (request, reply) => {
      const { name, permissions } = request.body;
      const store = getKeyStore();
      const entry = store.create(name, permissions);
      return reply.status(201).send(entry);
    },
  );

  fastify.get('/keys', { preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'List all API keys (secrets redacted)' } }, async (_request, reply) => {
    const store = getKeyStore();
    const keys = store.list().map(({ key: _key, previousKey: _prev, ...rest }) => rest);
    return reply.status(200).send(keys);
  });

  fastify.delete<{ Params: { id: string } }>(
    '/keys/:id',
    { preHandler: requireAdmin, schema: { tags: ['Keys'], summary: 'Delete an API key by ID' } },
    async (request, reply) => {
      const store = getKeyStore();
      const deleted = store.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Key not found.' });
      }
      return reply.status(204).send();
    },
  );

  // ── Rotation ───────────────────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    '/keys/:id/rotate',
    {
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

  // GET /keys/:id/rotation-status — check grace period status for a key
  fastify.get<{ Params: { id: string } }>(
    '/keys/:id/rotation-status',
    {
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
