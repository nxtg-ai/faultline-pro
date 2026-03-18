import type { FastifyInstance } from 'fastify';
import { getAnalyticsStore } from '../store/analytics.js';
import { getKeyStore } from '../store/keys.js';
import { getAuditLogger } from '../store/audit.js';

export async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/metrics', async (_request, reply) => {
    const dashboard = getAnalyticsStore().getDashboard();
    const activeKeys = getKeyStore().size;
    const auditEntries = getAuditLogger().getEntries().length;
    const { scans, riskDistribution } = dashboard;

    const lines = [
      '# HELP faultline_scans_total Scans processed by time period',
      '# TYPE faultline_scans_total gauge',
      `faultline_scans_total{period="today"} ${scans.today}`,
      `faultline_scans_total{period="week"} ${scans.week}`,
      `faultline_scans_total{period="month"} ${scans.month}`,
      '# HELP faultline_active_keys Number of active API keys',
      '# TYPE faultline_active_keys gauge',
      `faultline_active_keys ${activeKeys}`,
      '# HELP faultline_audit_log_entries Total audit log entries',
      '# TYPE faultline_audit_log_entries gauge',
      `faultline_audit_log_entries ${auditEntries}`,
      '# HELP faultline_risk_distribution Scans by risk level (all time)',
      '# TYPE faultline_risk_distribution gauge',
      `faultline_risk_distribution{level="low"} ${riskDistribution.low}`,
      `faultline_risk_distribution{level="medium"} ${riskDistribution.medium}`,
      `faultline_risk_distribution{level="high"} ${riskDistribution.high}`,
      `faultline_risk_distribution{level="critical"} ${riskDistribution.critical}`,
    ];

    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return lines.join('\n') + '\n';
  });
}
