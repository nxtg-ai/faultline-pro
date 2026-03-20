import Fastify from 'fastify';
import type { FastifyRequest, FastifyReply } from 'fastify';
import mercurius from 'mercurius';
import type {} from 'mercurius';

declare module 'mercurius' {
  interface MercuriusContext {
    keyId: string;
  }
}
import { schema as gqlSchema } from './graphql/schema.js';
import { resolvers as gqlResolvers } from './graphql/resolvers.js';
import { parseLang } from '@nxtg/faultline/lib/i18n.js';
import type { Lang } from '@nxtg/faultline/lib/i18n.js';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { healthRoutes } from './routes/health.js';
import { scanRoutes } from './routes/scan.js';
import { reportRoutes } from './routes/report.js';
import { uploadRoutes } from './routes/upload.js';
import { keysRoutes } from './routes/keys.js';
import { usageRoutes } from './routes/usage.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { webhookRoutes } from './routes/webhooks.js';
import { batchRoutes } from './routes/batch.js';
import { metricsRoutes } from './routes/metrics.js';
import { cacheRoutes } from './routes/cache.js';
import { jobRoutes } from './routes/jobs.js';
import { compareRoutes } from './routes/compare.js';
import { diffRoutes } from './routes/diff.js';
import { providerRoutes } from './routes/providers.js';
import { templateRoutes } from './routes/templates.js';
import { deepRoutes } from './routes/deep.js';
import { graphRoutes } from './routes/graph.js';
import { claimsRoutes } from './routes/claims.js';
import { euReportRoutes } from './routes/eu-report.js';
import { complianceRoutes } from './routes/compliance.js';
import { complianceCalendarRoutes } from './routes/compliance-calendar.js';
import { tenantsRoutes } from './routes/tenants.js';
import { costsRoutes } from './routes/costs.js';
import { scansRoutes } from './routes/scans.js';
import { bulkRoutes } from './routes/bulk.js';
import { exportRoutes } from './routes/export.js';
import { changelogRoutes } from './routes/changelog.js';
import { pluginMarketplaceRoutes } from './routes/plugins.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { rateLimitRoutes } from './routes/rate-limits.js';
import { notificationRoutes } from './routes/notifications.js';
import { queueRoutes } from './routes/queue.js';
import { rulesRoutes } from './routes/rules.js';
import { pdfReportRoutes } from './routes/pdf-report.js';
import { scheduleRoutes } from './routes/schedules.js';
import { orgRoutes } from './routes/orgs.js';
import { cacheWarmupRoutes } from './routes/cache-warmup.js';
import { getNotificationStore } from './store/notifications.js';
import { getKeyStore } from './store/keys.js';
import { getScanQueue, resetScanQueue } from './store/scan-queue.js';
import { getScheduleRunner, resetScheduleRunner } from './store/schedules.js';
import { getJobScheduler, resetJobScheduler } from './store/jobs.js';
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

  fastify.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server / curl
      const allowed = /^https:\/\/([\w-]+\.)?nxtg\.ai$/.test(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin);
      cb(allowed ? null : new Error('CORS: origin not allowed'), allowed);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization', 'Accept-Language'],
    credentials: true,
  });

  fastify.register(multipart, { limits: { fileSize: MAX_FILE_SIZE }, throwFileSizeLimit: false });

  fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Faultline API',
        description: 'FM-agnostic AI claim verification platform',
        version: '0.2.0',
      },
      servers: [{ url: 'https://faultline-api.fly.dev' }, { url: 'http://localhost:3000' }],
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        },
      },
      tags: [
        { name: 'Scan', description: 'Submit text for claim extraction and verification' },
        { name: 'Claims', description: 'Browse, search, and explain verified claims' },
        { name: 'Compliance', description: 'EU AI Act, industry templates, regulatory calendar' },
        { name: 'Jobs', description: 'Scheduled scans and bulk document processing' },
        { name: 'Analytics', description: 'Usage metrics, costs, and dashboard' },
        { name: 'Keys', description: 'API key and tenant management' },
        { name: 'Webhooks', description: 'Event subscriptions and delivery' },
        { name: 'Cache', description: 'Scan result cache management' },
        { name: 'Monitoring', description: 'Health, metrics, and provider status' },
        { name: 'Providers', description: 'Provider registry and health monitoring' },
        { name: 'Templates', description: 'Reusable scan configuration templates' },
        { name: 'Reports', description: 'Compliance report generation' },
      ],
    },
  });
  fastify.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });
  fastify.register(healthRoutes);
  fastify.register(scanRoutes);
  fastify.register(reportRoutes);
  fastify.register(uploadRoutes);
  fastify.register(keysRoutes);
  fastify.register(usageRoutes);
  fastify.register(dashboardRoutes);
  fastify.register(webhookRoutes);
  fastify.register(batchRoutes);
  fastify.register(metricsRoutes);
  fastify.register(cacheRoutes);
  fastify.register(jobRoutes);
  fastify.register(compareRoutes);
  fastify.register(diffRoutes);
  fastify.register(providerRoutes);
  // Node 20 ESM: access binding before register to avoid live-binding TDZ
  if (typeof templateRoutes !== 'function') throw new Error('templateRoutes not loaded');
  fastify.register(templateRoutes);
  fastify.register(deepRoutes);
  fastify.register(graphRoutes);
  fastify.register(claimsRoutes);
  fastify.register(euReportRoutes);
  fastify.register(complianceRoutes);
  fastify.register(complianceCalendarRoutes);
  fastify.register(tenantsRoutes);
  fastify.register(costsRoutes);
  fastify.register(scansRoutes);
  fastify.register(bulkRoutes);
  fastify.register(exportRoutes);
  fastify.register(changelogRoutes);
  fastify.register(pluginMarketplaceRoutes);
  fastify.register(telemetryRoutes);
  fastify.register(rateLimitRoutes);
  fastify.register(notificationRoutes);
  fastify.register(queueRoutes);
  fastify.register(rulesRoutes);
  fastify.register(pdfReportRoutes);
  fastify.register(scheduleRoutes);
  fastify.register(orgRoutes);
  fastify.register(cacheWarmupRoutes);

  fastify.register(mercurius, {
    schema: gqlSchema,
    resolvers: gqlResolvers,
    graphiql: false,
    context: (request: FastifyRequest) => {
      const keyId = request.keyId ?? 'anonymous';
      return { keyId };
    },
  });

  fastify.addHook('onReady', async () => {
    getJobScheduler().start();
    getScanQueue().start();
    getScheduleRunner().start();

    // Weekly summary notification — fires every Sunday 09:00 UTC
    setInterval(() => {
      // Clean expired grace-period keys every minute
      getKeyStore().cleanExpiredRotations();

      const now = new Date();
      if (now.getUTCDay() === 0 && now.getUTCHours() === 9 && now.getUTCMinutes() === 0) {
        const prefs = getNotificationStore().listPrefs().filter(p => p.events.includes('weekly.summary'));
        const summaries = prefs.map(p => ({
          keyId:       p.keyId,
          scanCount:   0, // usage meter does not expose per-key totals yet
          errorCount:  0,
          topProvider: 'gemini',
        }));
        if (summaries.length > 0) {
          void getNotificationStore().dispatch('weekly.summary', { summaries }).catch(() => undefined);
        }
      }
    }, 60_000);
  });

  fastify.addHook('onClose', async () => {
    getJobScheduler().stop();
    resetJobScheduler();
    getScanQueue().stop();
    resetScanQueue();
    getScheduleRunner().stop();
    resetScheduleRunner();
  });

  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    (request as FastifyRequest & { _startMs: number })._startMs = Date.now();
    (request as FastifyRequest & { lang: Lang }).lang = parseLang(request.headers['accept-language'] as string | undefined);
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

  fastify.setErrorHandler((error: { statusCode?: number; code?: string; message?: string }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const code = error.code ?? (statusCode === 404 ? 'NOT_FOUND' : statusCode === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR');
    reply.status(statusCode).send({
      error: error.message ?? 'An unexpected error occurred.',
      code,
    });
  });

  return fastify;
}
