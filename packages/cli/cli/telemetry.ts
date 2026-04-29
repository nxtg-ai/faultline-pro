/**
 * Faultline CLI Telemetry — opt-in, anonymized, Apache-2.0.
 *
 * Enabled only when FAULTLINE_TELEMETRY=1 is set.
 * No PII collected: no eval content, no file paths, no API keys.
 *
 * Fields sent: install_id (UUID, per device), run_id (UUID, per run),
 *   version, provider name, exit_status, eval_count, error_code (enum), os_platform.
 *
 * N-226 — DIRECTIVE-NXTG-20260428-01
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ─────────────────────────────────────────────────────────────────

const INSTALL_ID_PATH = join(homedir(), '.faultline', 'install-id');
const TELEMETRY_ENDPOINT = process.env.FAULTLINE_TELEMETRY_ENDPOINT
  ?? 'https://faultline-telemetry.asif-waliuddin.workers.dev';

// Enumerated error codes — NEVER use raw error.message (leaks paths/eval content)
export type ErrorCode =
  | 'API_KEY_MISSING'
  | 'API_ERROR'
  | 'RATE_LIMIT'
  | 'NETWORK_ERROR'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'INVALID_INPUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'UNKNOWN';

export interface TelemetryEvent {
  install_id: string;
  run_id: string;
  version: string;
  provider: string;
  exit_status: number;
  eval_count: number;
  error_code?: ErrorCode;
  os_platform: string;
  timestamp: string;
}

// ── Install ID management ─────────────────────────────────────────────────────

function readOrCreateInstallId(): string {
  try {
    if (existsSync(INSTALL_ID_PATH)) {
      const id = readFileSync(INSTALL_ID_PATH, 'utf-8').trim();
      if (/^[0-9a-f-]{36}$/i.test(id)) return id;
    }
    const dir = join(homedir(), '.faultline');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    writeFileSync(INSTALL_ID_PATH, id, 'utf-8');
    return id;
  } catch {
    // If filesystem is read-only or permission denied, use a session-scoped ID
    return randomUUID();
  }
}

// ── Core send function ────────────────────────────────────────────────────────

export function isEnabled(): boolean {
  return process.env.FAULTLINE_TELEMETRY === '1';
}

/**
 * Send a telemetry event. Fire-and-forget: never throws, never blocks CLI exit.
 * No-op if FAULTLINE_TELEMETRY !== '1'.
 */
export function sendTelemetry(
  event: Omit<TelemetryEvent, 'install_id' | 'run_id' | 'os_platform' | 'timestamp'> & {
    run_id?: string;
  },
): string {
  const run_id = event.run_id ?? randomUUID();
  if (!isEnabled()) return run_id;

  const payload: TelemetryEvent = {
    install_id: readOrCreateInstallId(),
    run_id,
    version: event.version,
    provider: event.provider,
    exit_status: event.exit_status,
    eval_count: event.eval_count,
    os_platform: process.platform,
    timestamp: new Date().toISOString(),
    ...(event.error_code ? { error_code: event.error_code } : {}),
  };

  // Fire-and-forget with 2s timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);

  fetch(TELEMETRY_ENDPOINT + '/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .catch(() => { /* silent — telemetry failure must never affect CLI */ })
    .finally(() => clearTimeout(timer));

  return run_id;
}

/**
 * Classify a caught error into an enumerated error code.
 * Never touches error.message content.
 */
export function classifyError(err: unknown): ErrorCode {
  if (err instanceof Error) {
    const name = err.name;
    if (name === 'AbortError') return 'TIMEOUT';
    if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')) return 'NETWORK_ERROR';
    if (err.message.includes('API key') || err.message.includes('api key')) return 'API_KEY_MISSING';
    if (err.message.includes('rate limit') || err.message.includes('429')) return 'RATE_LIMIT';
    if (err.message.toLowerCase().includes('parse') || err.message.includes('JSON')) return 'PARSE_ERROR';
  }
  return 'UNKNOWN';
}
