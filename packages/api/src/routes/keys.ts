import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { getKeyStore } from '../store/keys.js';
import type { Permission } from '../store/keys.js';

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
    { preHandler: requireAdmin, schema: { body: CREATE_BODY_SCHEMA } },
    async (request, reply) => {
      const { name, permissions } = request.body;
      const store = getKeyStore();
      const entry = store.create(name, permissions);
      return reply.status(201).send(entry);
    },
  );

  fastify.get('/keys', { preHandler: requireAdmin }, async (_request, reply) => {
    const store = getKeyStore();
    const keys = store.list().map(({ key: _key, ...rest }) => rest);
    return reply.status(200).send(keys);
  });

  fastify.delete<{ Params: { id: string } }>(
    '/keys/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const store = getKeyStore();
      const deleted = store.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Key not found.' });
      }
      return reply.status(204).send();
    },
  );
}
