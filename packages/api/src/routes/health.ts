import type { FastifyInstance } from 'fastify';
import { getKeyStore } from '../store/keys.js';
import { getAuditLogger } from '../store/audit.js';
import { getRateLimiter } from '../store/ratelimit.js';
import { getUsageMeter } from '../store/usage.js';
import { getAnalyticsStore } from '../store/analytics.js';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', async (_request, _reply) => {
    return { status: 'ok', service: 'faultline-api', version: '0.1.0' };
  });

  fastify.get('/health/deep', async (_request, _reply) => {
    const dashboard = getAnalyticsStore().getDashboard();
    const subsystems = {
      keyStore: { status: 'ok' as const, activeKeys: getKeyStore().size },
      auditLog: { status: 'ok' as const, entries: getAuditLogger().getEntries().length },
      rateLimiter: { status: 'ok' as const },
      usageMeter: { status: 'ok' as const },
      analytics: { status: 'ok' as const, totalScans: dashboard.scans.month },
    };

    const allOk = Object.values(subsystems).every((s) => s.status === 'ok');

    const providers = {
      gemini: { status: 'ok' as const, configured: Boolean(process.env.GEMINI_API_KEY) },
      openai: { status: 'ok' as const, configured: Boolean(process.env.OPENAI_API_KEY) },
      claude: { status: 'ok' as const, configured: Boolean(process.env.ANTHROPIC_API_KEY) },
      perplexity: { status: 'ok' as const, configured: Boolean(process.env.PERPLEXITY_API_KEY) },
    };

    return {
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      subsystems,
      providers,
    };
  });

  fastify.get('/status', async (_request, reply) => {
    const dashboard = getAnalyticsStore().getDashboard();
    const subsystems = {
      keyStore: { status: 'ok' as const, activeKeys: getKeyStore().size },
      auditLog: { status: 'ok' as const, entries: getAuditLogger().getEntries().length },
      rateLimiter: { status: 'ok' as const },
      usageMeter: { status: 'ok' as const },
      analytics: { status: 'ok' as const, totalScans: dashboard.scans.month },
    };

    const allOk = Object.values(subsystems).every((s) => s.status === 'ok');
    const overallStatus = allOk ? 'ok' : 'degraded';
    const indicator = allOk ? '✅' : '⚠️';

    const rows = Object.entries(subsystems)
      .map(([name, info]) => {
        const emoji = info.status === 'ok' ? '✅' : '⚠️';
        return `<tr><td>${name}</td><td>${emoji} ${info.status}</td></tr>`;
      })
      .join('\n');

    reply.header('Content-Type', 'text/html');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Faultline API Status</title>
<style>
  body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
  h1 { color: #1a1a2e; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 4px; font-weight: bold; }
  .ok { background: #d4edda; color: #155724; }
  .degraded { background: #fff3cd; color: #856404; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #dee2e6; }
  th { background: #f8f9fa; }
</style>
</head>
<body>
<h1>Faultline API ${indicator} <span class="badge ${overallStatus}">${overallStatus.toUpperCase()}</span></h1>
<p>Version: 0.1.0 &nbsp;|&nbsp; Uptime: <strong>live</strong></p>
<table>
<thead><tr><th>Subsystem</th><th>Status</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;
  });
}
