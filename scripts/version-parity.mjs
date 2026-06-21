#!/usr/bin/env node
// Deterministic version-parity gate for @nxtg/faultline.
//
// Proves the "shipped, coherent product" contract: the DEPLOYED running
// instance, the npm `latest` dist-tag, and the in-repo published manifests
// (cli + api) all report the SAME version. This is the honest form of
// "deployed-version == npm-latest" — it probes the live service, not just
// package.json, so a package.json==npm match cannot fake-green a drifted
// deployment.
//
// FAILS CLOSED: if any source is unreachable/unparseable, the gate is RED
// (exit 1) — never green-on-missing-data. Same posture as the citation gate
// (d869b98): a degraded probe is a failure, not a pass.
//
// Sources (override via env):
//   FAULTLINE_DEPLOYED_HEALTH_URL  default https://faultline-api.fly.dev/health
//   FAULTLINE_NPM_PKG              default @nxtg/faultline
// Optional:
//   --expect <version>   also assert every source equals <version> (e.g. 0.8.0)
//
// Exit 0 = all sources present AND equal (AND == --expect if given). Else 1.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NPM_PKG = process.env.FAULTLINE_NPM_PKG || '@nxtg/faultline';
const DEPLOYED_URL =
  process.env.FAULTLINE_DEPLOYED_HEALTH_URL || 'https://faultline-api.fly.dev/health';
const expectIdx = process.argv.indexOf('--expect');
const EXPECT = expectIdx !== -1 ? process.argv[expectIdx + 1] : null;
const TIMEOUT_MS = 15000;

const errors = [];
const sources = {}; // label -> version string

function readManifest(label, relPath) {
  try {
    const v = JSON.parse(readFileSync(join(ROOT, relPath), 'utf8')).version;
    if (!v || typeof v !== 'string') throw new Error('no version field');
    sources[label] = v.trim();
  } catch (e) {
    errors.push(`${label} (${relPath}): ${e.message}`);
  }
}

function readNpm(label, pkg) {
  try {
    const out = execFileSync('npm', ['view', pkg, 'dist-tags.latest'], {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!out) throw new Error('empty npm response');
    sources[label] = out;
  } catch (e) {
    errors.push(`${label} (npm view ${pkg}): ${e.message}`);
  }
}

async function readDeployed(label, url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body || typeof body.version !== 'string' || !body.version) {
      throw new Error('no .version in /health body');
    }
    sources[label] = body.version.trim();
  } catch (e) {
    errors.push(`${label} (${url}): ${e.message}`);
  }
}

readManifest('repo:cli', 'packages/cli/package.json');
readManifest('repo:api', 'packages/api/package.json');
readNpm('npm:latest', NPM_PKG);
await readDeployed('deployed:fly', DEPLOYED_URL);

const labels = ['repo:cli', 'repo:api', 'npm:latest', 'deployed:fly'];
console.log('Version parity — @nxtg/faultline');
for (const l of labels) console.log(`  ${l.padEnd(13)} ${sources[l] ?? '<UNREACHABLE>'}`);
if (EXPECT) console.log(`  --expect      ${EXPECT}`);

// FAIL CLOSED on any unreachable/unparseable source.
if (errors.length) {
  console.error('\nFAIL (closed) — source(s) unreachable/unparseable:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const values = labels.map((l) => sources[l]);
const expected = EXPECT || values[0];
const mismatch = labels.filter((l) => sources[l] !== expected);

if (mismatch.length) {
  console.error(`\nFAIL — version mismatch (expected ${expected}):`);
  for (const l of mismatch) console.error(`  - ${l} = ${sources[l]} != ${expected}`);
  process.exit(1);
}

console.log(`\nPASS — all sources at ${expected}. Deployed == npm-latest == repo.`);
process.exit(0);
