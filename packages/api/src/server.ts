import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { healthRoutes } from './routes/health.js';
import { scanRoutes } from './routes/scan.js';
import { reportRoutes } from './routes/report.js';
import { uploadRoutes } from './routes/upload.js';
import { keysRoutes } from './routes/keys.js';
import { usageRoutes } from './routes/usage.js';
import { getAuditLogger, hashInput } from './store/audit.js';
import { getUsageMeter } from './store/usage.js';

const MAX_FILE_SIZE = 10_485_760; // 10MB

/**
 * Build and configure a Fastify server instance.
 * Exported as a factory so tests can create isolated instances with inject().
 */
export function buildServer() {
  const fastify = Fastify({
    logger: false,
  });

  fastify.register(multipart, { limits: { fileSize: MAX_FILE_SIZE }, throwFileSizeLimit: false });
  fastify.register(healthRoutes);
  fastify.register(scanRoutes);
  fastify.register(reportRoutes);
  fastify.register(uploadRoutes);
  fastify.register(keysRoutes);
  fastify.register(usageRoutes);

  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    (request as FastifyRequest & { _startMs: number })._startMs = Date.now();
  });

  fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const startMs = (request as FastifyRequest & { _startMs?: number })._startMs ?? Date.now();
    const latencyMs = Date.now() - startMs;
    const keyId = request.keyId ?? 'unknown';
    const endpoint = request.url;
    const method = request.method;
    const statusCode = reply.statusCode;

    const isScanPost =
      method === 'POST' && (endpoint === '/scan' || endpoint === '/scan/upload');

    let inputHash: string | undefined;
    if (isScanPost && typeof (request.body as Record<string, unknown>)?.text === 'string') {
      inputHash = hashInput((request.body as Record<string, unknown>).text as string);
    }

    getAuditLogger().log({ timestamp: new Date().toISOString(), keyId, endpoint, method, statusCode, latencyMs, inputHash });

    if (isScanPost && statusCode === 200) {
      getUsageMeter().increment(keyId);
    }
  });

  return fastify;
}
