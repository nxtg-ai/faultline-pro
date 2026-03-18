import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { healthRoutes } from './routes/health.js';
import { scanRoutes } from './routes/scan.js';
import { reportRoutes } from './routes/report.js';
import { uploadRoutes } from './routes/upload.js';

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

  return fastify;
}
