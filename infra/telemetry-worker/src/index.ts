/**
 * Faultline Telemetry Worker — Apache-2.0
 *
 * POST /events — ingest opt-in CLI telemetry events
 * GET  /api/stats — aggregated funnel + error fingerprint for ASIF dashboard
 *
 * Privacy: no PII stored. Whitelist enforced server-side.
 * Operator: Cloudflare (wnam region).
 */

export interface Env {
  DB: D1Database;
}

// Whitelisted fields only — anything else is dropped
const ALLOWED_PROVIDERS = new Set(['gemini', 'openai', 'claude', 'perplexity', 'mock']);
const ALLOWED_PLATFORMS = new Set(['linux', 'darwin', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix']);
const ALLOWED_ERROR_CODES = new Set([
  'API_KEY_MISSING', 'API_ERROR', 'RATE_LIMIT', 'NETWORK_ERROR',
  'PARSE_ERROR', 'TIMEOUT', 'INVALID_INPUT', 'PROVIDER_UNAVAILABLE', 'UNKNOWN',
]);

interface TelemetryEvent {
  install_id: string;
  run_id: string;
  version: string;
  provider: string;
  exit_status: number;
  eval_count: number;
  error_code?: string;
  os_platform: string;
  timestamp: string;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  if (!body || typeof body !== 'object') return jsonResponse({ error: 'invalid_body' }, 400);
  const e = body as Record<string, unknown>;

  // Validate and sanitize — whitelist enforced
  const install_id = typeof e.install_id === 'string' && isUuid(e.install_id) ? e.install_id : null;
  const run_id     = typeof e.run_id === 'string' && isUuid(e.run_id) ? e.run_id : null;
  const version    = typeof e.version === 'string' && /^[\d.]+(-\w+)?$/.test(e.version) ? e.version : null;
  const provider   = typeof e.provider === 'string' && ALLOWED_PROVIDERS.has(e.provider) ? e.provider : null;
  const exit_status = typeof e.exit_status === 'number' && Number.isInteger(e.exit_status) ? e.exit_status : null;
  const eval_count  = typeof e.eval_count === 'number' && Number.isInteger(e.eval_count) ? Math.max(0, e.eval_count) : 0;
  const error_code  = typeof e.error_code === 'string' && ALLOWED_ERRORS.has(e.error_code) ? e.error_code : null;
  const os_platform = typeof e.os_platform === 'string' && ALLOWED_PLATFORMS.has(e.os_platform) ? e.os_platform : 'unknown';
  const timestamp   = typeof e.timestamp === 'string' ? e.timestamp.slice(0, 30) : new Date().toISOString();

  if (!install_id || !run_id || !version || !provider || exit_status === null) {
    return jsonResponse({ error: 'missing_required_fields' }, 422);
  }

  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO telemetry_events
         (install_id, run_id, version, provider, exit_status, eval_count, error_code, os_platform, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(install_id, run_id, version, provider, exit_status, eval_count, error_code, os_platform, timestamp).run();
  } catch (err) {
    console.error('D1 insert error:', err);
    return jsonResponse({ error: 'db_error' }, 500);
  }

  return jsonResponse({ ok: true }, 201);
}

async function handleStats(env: Env): Promise<Response> {
  const [runStats, repeatSignal, errorStats, dailyActive] = await Promise.all([
    // Total runs + unique installs
    env.DB.prepare(`
      SELECT COUNT(*) AS total_runs,
             COUNT(DISTINCT install_id) AS unique_installs,
             COUNT(DISTINCT provider) AS provider_count
      FROM telemetry_events
    `).first<{ total_runs: number; unique_installs: number; provider_count: number }>(),

    // Funnel: how many installs have 1, 2-4, 5-9, 10+ runs
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN run_count = 1 THEN 1 ELSE 0 END) AS single_run,
        SUM(CASE WHEN run_count BETWEEN 2 AND 4 THEN 1 ELSE 0 END) AS two_to_four,
        SUM(CASE WHEN run_count BETWEEN 5 AND 9 THEN 1 ELSE 0 END) AS five_to_nine,
        SUM(CASE WHEN run_count >= 10 THEN 1 ELSE 0 END) AS ten_plus
      FROM (
        SELECT install_id, COUNT(*) AS run_count
        FROM telemetry_events
        GROUP BY install_id
      )
    `).first<{ single_run: number; two_to_four: number; five_to_nine: number; ten_plus: number }>(),

    // Top error codes (last 7 days)
    env.DB.prepare(`
      SELECT error_code, COUNT(*) AS cnt
      FROM telemetry_events
      WHERE error_code IS NOT NULL
        AND timestamp >= datetime('now', '-7 days')
      GROUP BY error_code
      ORDER BY cnt DESC
      LIMIT 3
    `).all<{ error_code: string; cnt: number }>(),

    // Daily active installs (last 30 days)
    env.DB.prepare(`
      SELECT substr(timestamp, 1, 10) AS day,
             COUNT(DISTINCT install_id) AS active_installs,
             COUNT(*) AS runs
      FROM telemetry_events
      WHERE timestamp >= datetime('now', '-30 days')
      GROUP BY day
      ORDER BY day ASC
    `).all<{ day: string; active_installs: number; runs: number }>(),
  ]);

  return jsonResponse({
    run_stats: runStats,
    repeat_signal: repeatSignal,
    top_errors: errorStats.results,
    daily_active: dailyActive.results,
    generated_at: new Date().toISOString(),
  });
}

// Reference to set (named correctly above in handleIngest)
const ALLOWED_ERRORS = ALLOWED_ERROR_CODES;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (method === 'POST' && url.pathname === '/events') {
      return handleIngest(request, env);
    }

    if (method === 'GET' && url.pathname === '/api/stats') {
      return handleStats(env);
    }

    if (method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ ok: true, version: '1.0.0' });
    }

    return jsonResponse({ error: 'not_found' }, 404);
  },
};
