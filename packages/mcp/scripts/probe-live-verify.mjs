#!/usr/bin/env node
/**
 * DoD probe §4.2 — live verify_claims against real sources.
 *
 * Spawns the shipped MCP binary, completes an MCP handshake, and calls
 * verify_claims on a seeded three-claim text containing one well-established
 * truth, one well-documented falsehood, and one further truth.
 *
 * PASS requires, from a REAL provider (never mock):
 *   - at least one VERIFIED claim
 *   - at least one REFUTED claim
 *   - evidence URLs present on the verdicts
 *
 * This probe costs provider tokens. It is deliberately NOT part of the default
 * vitest run — spec §5 requires real API calls for acceptance, and a test suite
 * that silently bills on every run is a suite people stop running.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/probe-live-verify.mjs
 *   OPENAI_API_KEY=... node scripts/probe-live-verify.mjs --provider openai
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'bin', 'faultline-mcp.js');

const argv = process.argv.slice(2);
const providerFlag = argv.indexOf('--provider');
const provider = providerFlag !== -1 ? argv[providerFlag + 1] : undefined;

const SEEDED_TEXT = [
  'The Eiffel Tower is located in Paris, France.',
  'The Great Wall of China is visible from the Moon with the naked eye.',
  'Water boils at 100 degrees Celsius at standard atmospheric pressure at sea level.',
].join(' ');

function fail(msg) {
  process.stderr.write(`\n✗ DoD §4.2 FAIL — ${msg}\n`);
  process.exit(1);
}

const resolvedProvider =
  provider ||
  (process.env.GEMINI_API_KEY && 'gemini') ||
  (process.env.OPENAI_API_KEY && 'openai') ||
  (process.env.ANTHROPIC_API_KEY && 'claude') ||
  (process.env.PERPLEXITY_API_KEY && 'perplexity');

if (!resolvedProvider || resolvedProvider === 'mock') {
  fail(
    'no real provider key in the environment. This probe requires live verification; ' +
      'mock returns synthetic results and cannot satisfy the DoD. ' +
      'Set GEMINI_API_KEY (free: https://aistudio.google.com/apikey).',
  );
}

process.stderr.write(`DoD §4.2 probe — provider: ${resolvedProvider}\n`);
process.stderr.write(`Seeded text: ${SEEDED_TEXT}\n\n`);

const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
let stderrBuf = '';
const timer = setTimeout(() => {
  child.kill('SIGTERM');
  fail(`timed out after 180s. stderr:\n${stderrBuf}`);
}, 180_000);

child.stderr.on('data', (d) => {
  stderrBuf += d.toString();
  process.stderr.write(d);
});

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      clearTimeout(timer);
      child.kill('SIGTERM');
      fail(`non-JSON on stdout (corrupts the MCP stream): ${line}`);
    }

    if (msg.id === 1) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'verify_claims',
            arguments: { text: SEEDED_TEXT, provider: resolvedProvider },
          },
        }) + '\n',
      );
    }

    if (msg.id === 2) {
      clearTimeout(timer);
      child.kill('SIGTERM');
      evaluate(msg);
    }
  }
});

child.on('error', (err) => fail(`could not start server: ${err.message}`));

function evaluate(msg) {
  if (msg.error) fail(`tools/call returned an error: ${JSON.stringify(msg.error)}`);
  if (msg.result?.isError) {
    fail(`the tool reported failure: ${msg.result.content?.[0]?.text ?? '(no detail)'}`);
  }

  const payload =
    msg.result?.structuredContent ??
    (() => {
      try {
        return JSON.parse(msg.result?.content?.[0]?.text ?? '{}');
      } catch {
        return {};
      }
    })();

  process.stdout.write(JSON.stringify(payload, null, 2) + '\n\n');

  if (payload.provider === 'mock') {
    fail('the scan ran on the mock provider — synthetic results cannot satisfy the DoD.');
  }

  const claims = Array.isArray(payload.claims) ? payload.claims : [];
  if (claims.length === 0) fail('no claims were extracted from the seeded text.');

  const verified = claims.filter((c) => c.verdict === 'VERIFIED');
  const refuted = claims.filter((c) => c.verdict === 'REFUTED');
  const withEvidence = claims.filter((c) => (c.evidence_urls?.length ?? 0) > 0);

  const lines = [
    `claims extracted : ${payload.claims_total}`,
    `VERIFIED         : ${verified.length}`,
    `REFUTED          : ${refuted.length}`,
    `with evidence    : ${withEvidence.length}`,
    `degraded         : ${payload.degraded}`,
    `unchecked        : ${payload.unchecked_count}`,
    `audit_ref        : ${payload.audit_ref ?? '(none)'}`,
    `provider         : ${payload.provider}`,
  ];
  process.stdout.write(lines.join('\n') + '\n\n');

  if (payload.degraded) {
    fail(
      `the scan was DEGRADED (${payload.unchecked_count} claim(s) unchecked) — ` +
        'a degraded scan cannot certify the DoD. Re-run when the provider is healthy.',
    );
  }
  if (verified.length < 1) fail('expected at least one VERIFIED claim, got none.');
  if (refuted.length < 1) fail('expected at least one REFUTED claim, got none.');
  if (withEvidence.length < 1) fail('expected evidence URLs on at least one verdict, got none.');

  process.stdout.write('✓ DoD §4.2 PASS — live verification returned VERIFIED + REFUTED with evidence.\n');
  process.exit(0);
}

child.stdin.write(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'faultline-dod-probe-4.2', version: '1.0.0' },
    },
  }) + '\n',
);
