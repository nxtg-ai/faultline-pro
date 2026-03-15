import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Prehandler: validate x-api-key header against FAULTLINE_API_KEY env var.
 * Returns 503 if server is not configured, 401 if key is missing or wrong.
 */
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const configuredKey = process.env.FAULTLINE_API_KEY;

  if (!configuredKey) {
    reply.status(503).send({ error: 'API key not configured on server.' });
    return;
  }

  const providedKey = request.headers['x-api-key'];

  if (!providedKey || providedKey !== configuredKey) {
    reply.status(401).send({ error: 'Unauthorized. Provide a valid x-api-key header.' });
  }
}
