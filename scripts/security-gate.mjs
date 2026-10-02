#!/usr/bin/env node
/**
 * scripts/security-gate.mjs: the ratchet behind .github/workflows/security-scan.yml.
 *
 * SARIF mode compares the blocking results of each scanner against
 * security/baseline.json. Findings that existed when the gate was installed are
 * baselined with a reason; any NEW blocking finding fails.
 *
 *   node scripts/security-gate.mjs --sarif semgrep=semgrep.sarif --sarif bearer=bearer.sarif \
 *     [--baseline security/baseline.json]
 *
 * npm mode fails on any high/critical advisory in `npm audit --json` output whose
 * GHSA id is not accepted in security/accepted-advisories.json, or whose
 * acceptance is past its review_by date.
 *
 *   node scripts/security-gate.mjs --npm npm-audit.json [--accepted security/accepted-advisories.json]
 *
 * Exit codes: 0 pass, 1 a new blocking finding or unaccepted advisory,
 * 2 the input cannot be trusted (missing, unparseable, or the scanner reported
 * that it failed). A check that passes when it cannot run is not evidence, so
 * exit 2 is a failure in CI, never a pass.
 *
 * No dependencies; Node 20+.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, INVALID: 2 });

/** SARIF levels that block, per tool. A tool not listed here is rejected. */
export const BLOCKING_LEVELS = Object.freeze({
  semgrep: ['error'],
  bearer: ['error'],
});

/** Substring the SARIF tool.driver.name must contain, so swapped files are caught. */
const DRIVER_NAMES = Object.freeze({ semgrep: 'semgrep', bearer: 'bearer' });

const BLOCKING_SEVERITIES = ['high', 'critical'];
const BASELINE_FIELDS = ['tool', 'ruleId', 'uri', 'fp', 'disposition', 'reason'];
const ADVISORY_FIELDS = ['ghsa', 'package', 'severity', 'disposition', 'reason', 'review_by'];

/** An input that cannot be trusted. Maps to exit 2. */
export class GateInputError extends Error {}

/** Default logger: gate output is finding metadata (rule, file, fingerprint), never secrets. */
function writeLine(line) {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function readJson(file, what) {
  if (!file || !existsSync(file)) throw new GateInputError(`${what} not found: ${file}`);
  const text = readFileSync(file, 'utf8');
  if (text.trim() === '') throw new GateInputError(`${what} is empty: ${file}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GateInputError(`${what} is not valid JSON (${file}): ${error.message}`);
  }
}

function requireStringFields(entry, fields, label) {
  for (const field of fields) {
    if (typeof entry?.[field] !== 'string' || entry[field].trim() === '') {
      throw new GateInputError(`${label}: field "${field}" must be a non-empty string`);
    }
  }
}

/** Collapse whitespace so a reflowed message keeps its fingerprint. */
export function normalizeMessage(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Repo-relative, forward-slash URI. Scanners in containers can emit absolute
 * paths or file:// URIs; the fingerprint must not depend on where CI checked out.
 */
export function normalizeUri(uri, root = process.cwd()) {
  let value = String(uri ?? '');
  if (value.startsWith('file://')) value = decodeURIComponent(value.slice('file://'.length));
  value = value.replace(/\\/g, '/');
  const rootSlash = root.replace(/\\/g, '/').replace(/\/?$/, '/');
  if (value.startsWith(rootSlash)) value = value.slice(rootSlash.length);
  return value.replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------
// SARIF mode
// ---------------------------------------------------------------------------

/**
 * Location part of the fingerprint. Never the line number: lines move.
 * Bearer gives a line-content hash; semgrep OSS gives none (its
 * fingerprints.matchBasedId is the constant "requires login"), so it falls back
 * to a hash of the message text.
 */
export function locationFingerprint(result) {
  const lineContentId = result?.partialFingerprints?.primaryLocationLineHash;
  if (typeof lineContentId === 'string' && lineContentId.length > 0) return lineContentId;
  const digest = createHash('sha256').update(normalizeMessage(result?.message?.text)).digest('hex');
  return `msg:${digest.slice(0, 32)}`;
}

/** Stable identity of a finding: tool + rule + file + location fingerprint. */
export function findingKey({ tool, ruleId, uri, fp }) {
  return [tool, ruleId, uri, fp].join('|');
}

/** SARIF 2.1.0 §3.27.10: result.level, else the rule's default, else "warning". */
function resolveLevel(result, rulesById, rules) {
  if (result.level) return result.level;
  const rule = rulesById.get(result.ruleId)
    ?? (Number.isInteger(result.ruleIndex) ? rules[result.ruleIndex] : undefined);
  return rule?.defaultConfiguration?.level ?? 'warning';
}

/**
 * SARIF 2.1.0 §3.27.23: a result with a suppression whose status is absent or
 * "accepted" is suppressed. Semgrep reports `# nosemgrep:` lines this way
 * (kind "inSource") instead of dropping them.
 */
function isSuppressed(result) {
  return (result.suppressions ?? []).some((s) => s?.status === undefined || s?.status === 'accepted');
}

function validateRun(run, tool, file) {
  const driver = run?.tool?.driver;
  if (!driver || typeof driver.name !== 'string') {
    throw new GateInputError(`${tool}: SARIF run has no tool.driver.name (${file})`);
  }
  if (!driver.name.toLowerCase().includes(DRIVER_NAMES[tool])) {
    throw new GateInputError(`${tool}: SARIF was produced by "${driver.name}", not ${tool} (${file})`);
  }
  // Levels live on the rules; a run with no rules means the scanner loaded no config.
  if (!Array.isArray(driver.rules) || driver.rules.length === 0) {
    throw new GateInputError(`${tool}: SARIF run lists no rules, so the scanner ran nothing (${file})`);
  }
  if (!Array.isArray(run.results)) {
    throw new GateInputError(`${tool}: SARIF run has no results array (${file})`);
  }
  const failed = (run.invocations ?? []).find((inv) => inv?.executionSuccessful === false);
  if (failed) throw new GateInputError(`${tool}: scanner reported executionSuccessful=false (${file})`);
}

/**
 * Parse one scanner's SARIF into its blocking findings.
 * Throws GateInputError when the file cannot be trusted.
 */
export function loadBlockingFindings(tool, file, root = process.cwd()) {
  if (!BLOCKING_LEVELS[tool]) throw new GateInputError(`unknown tool "${tool}"`);
  const sarif = readJson(file, `${tool} SARIF`);
  if (!Array.isArray(sarif?.runs) || sarif.runs.length === 0) {
    throw new GateInputError(`${tool}: SARIF has no runs (${file})`);
  }
  const findings = [];
  for (const run of sarif.runs) {
    validateRun(run, tool, file);
    const rules = run.tool.driver.rules;
    const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
    for (const result of run.results) {
      if (isSuppressed(result)) continue;
      if (!BLOCKING_LEVELS[tool].includes(resolveLevel(result, rulesById, rules))) continue;
      const location = result.locations?.[0]?.physicalLocation ?? {};
      findings.push({
        tool,
        ruleId: String(result.ruleId ?? rules[result.ruleIndex]?.id ?? 'unknown-rule'),
        uri: normalizeUri(location.artifactLocation?.uri, root),
        line: location.region?.startLine ?? '?',
        fp: locationFingerprint(result),
        message: normalizeMessage(result.message?.text),
      });
    }
  }
  return findings;
}

/** Read and validate security/baseline.json. */
export function loadBaseline(file) {
  const baseline = readJson(file, 'baseline');
  if (!Array.isArray(baseline?.entries)) throw new GateInputError(`baseline has no "entries" array (${file})`);
  baseline.entries.forEach((entry, index) => requireStringFields(entry, BASELINE_FIELDS, `baseline entry ${index}`));
  return baseline.entries;
}

function countByKey(items) {
  const counts = new Map();
  for (const item of items) {
    const key = findingKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Compare findings with the baseline as multisets: a key baselined once and
 * found twice is one new finding, so a copy-pasted vulnerable line still blocks.
 * Only tools that were scanned this run are compared for staleness.
 */
export function compareWithBaseline(findings, baselineEntries, scannedTools) {
  const allowed = countByKey(baselineEntries);
  const found = countByKey(findings);
  const newFindings = [];
  const seen = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    const index = (seen.get(key) ?? 0) + 1;
    seen.set(key, index);
    if (index > (allowed.get(key) ?? 0)) newFindings.push(finding);
  }
  const stale = [];
  const staleSeen = new Map();
  for (const entry of baselineEntries) {
    if (!scannedTools.includes(entry.tool)) continue;
    const key = findingKey(entry);
    const index = (staleSeen.get(key) ?? 0) + 1;
    staleSeen.set(key, index);
    if (index > (found.get(key) ?? 0)) stale.push(entry);
  }
  return { newFindings, stale };
}

function baselineStub(finding) {
  return {
    tool: finding.tool,
    ruleId: finding.ruleId,
    uri: finding.uri,
    fp: finding.fp,
    disposition: 'TODO',
    reason: 'TODO: why this is accepted, or OPEN: <what must be fixed>',
  };
}

/**
 * Run the SARIF ratchet.
 * @param {{inputs: {tool: string, file: string}[], baselinePath: string, root?: string,
 *          log?: (line: string) => void}} options
 * @returns {{exitCode: number, newFindings: object[], stale: object[], findings: object[]}}
 */
export function runSarifGate({ inputs, baselinePath, root = process.cwd(), log = writeLine }) {
  try {
    if (!inputs?.length) throw new GateInputError('no --sarif inputs given');
    const findings = inputs.flatMap(({ tool, file }) => loadBlockingFindings(tool, file, root));
    const baseline = loadBaseline(baselinePath);
    const scannedTools = inputs.map(({ tool }) => tool);
    const { newFindings, stale } = compareWithBaseline(findings, baseline, scannedTools);
    for (const tool of scannedTools) {
      log(`${tool}: ${findings.filter((f) => f.tool === tool).length} blocking findings`);
    }
    for (const entry of stale) {
      log(`STALE (not failing): ${entry.tool} ${entry.ruleId} ${entry.uri} fp=${entry.fp} is no longer found; remove it from the baseline`);
    }
    for (const finding of newFindings) {
      log(`NEW BLOCKING: ${finding.tool} ${finding.ruleId} ${finding.uri}:${finding.line} fp=${finding.fp}`);
    }
    if (newFindings.length > 0) {
      log(`FAIL: ${newFindings.length} new blocking finding(s) not in ${baselinePath}.`);
      log('Fix them, or add a reviewed entry per finding (stubs below):');
      log(JSON.stringify(newFindings.map(baselineStub), null, 2));
      return { exitCode: EXIT.FAIL, newFindings, stale, findings };
    }
    log(`PASS: every blocking finding is baselined (${baseline.length} baseline entries, ${stale.length} stale).`);
    return { exitCode: EXIT.PASS, newFindings, stale, findings };
  } catch (error) {
    return invalid(error, log);
  }
}

// ---------------------------------------------------------------------------
// npm audit mode
// ---------------------------------------------------------------------------

function ghsaFromUrl(url) {
  const match = /GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/i.exec(String(url ?? ''));
  return match ? match[0] : null;
}

/** High/critical advisories from `npm audit --json` (report version 2), one per GHSA id. */
export function loadBlockingAdvisories(file) {
  const report = readJson(file, 'npm audit report');
  if (report?.error) {
    throw new GateInputError(`npm audit reported an error: ${report.error.summary ?? JSON.stringify(report.error)}`);
  }
  if (report?.auditReportVersion !== 2 || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) {
    throw new GateInputError(`not an npm audit v2 report (auditReportVersion=${report?.auditReportVersion}): ${file}`);
  }
  // An audit of an empty tree reports zero advisories and would pass vacuously.
  const productionDependencies = report.metadata?.dependencies?.prod;
  if (!Number.isInteger(productionDependencies) || productionDependencies < 1) {
    throw new GateInputError(`npm audit saw no production dependencies (metadata.dependencies.prod=${productionDependencies}): ${file}`);
  }
  const advisories = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of vulnerability?.via ?? []) {
      if (typeof via !== 'object' || !BLOCKING_SEVERITIES.includes(via.severity)) continue;
      const ghsa = ghsaFromUrl(via.url);
      if (!ghsa) throw new GateInputError(`advisory for ${via.name} has no GHSA id in url "${via.url}"`);
      if (!advisories.has(ghsa)) {
        advisories.set(ghsa, { ghsa, package: via.name, severity: via.severity, title: via.title, url: via.url });
      }
    }
  }
  return [...advisories.values()];
}

/** Read and validate security/accepted-advisories.json. */
export function loadAcceptedAdvisories(file) {
  const accepted = readJson(file, 'accepted advisories');
  if (!Array.isArray(accepted)) throw new GateInputError(`accepted advisories must be a JSON array (${file})`);
  accepted.forEach((entry, index) => {
    requireStringFields(entry, ADVISORY_FIELDS, `accepted advisory ${index}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.review_by)) {
      throw new GateInputError(`accepted advisory ${index}: review_by must be YYYY-MM-DD, got "${entry.review_by}"`);
    }
  });
  return accepted;
}

function advisoryStub(advisory) {
  return {
    ghsa: advisory.ghsa,
    package: advisory.package,
    severity: advisory.severity,
    disposition: 'TODO',
    reason: `TODO: ${advisory.title}`,
    review_by: 'YYYY-MM-DD',
  };
}

/**
 * Run the npm audit gate. An acceptance past review_by fails whether or not
 * the advisory is still present: the review date is the commitment.
 * @param {{auditPath: string, acceptedPath: string, today?: string, log?: (line: string) => void}} options
 */
export function runNpmGate({ auditPath, acceptedPath, today = new Date().toISOString().slice(0, 10), log = writeLine }) {
  try {
    const advisories = loadBlockingAdvisories(auditPath);
    const accepted = loadAcceptedAdvisories(acceptedPath);
    const acceptedById = new Map(accepted.map((entry) => [entry.ghsa.toUpperCase(), entry]));
    const expired = accepted.filter((entry) => entry.review_by < today);
    const unaccepted = advisories.filter((advisory) => !acceptedById.has(advisory.ghsa.toUpperCase()));
    const foundIds = new Set(advisories.map((advisory) => advisory.ghsa.toUpperCase()));

    log(`npm audit: ${advisories.length} high/critical advisories, ${accepted.length} accepted`);
    for (const entry of accepted.filter((e) => !foundIds.has(e.ghsa.toUpperCase()))) {
      log(`STALE (not failing unless expired): ${entry.ghsa} (${entry.package}) is no longer reported`);
    }
    for (const entry of expired) {
      log(`EXPIRED: ${entry.ghsa} (${entry.package}) review_by ${entry.review_by} is before ${today}`);
    }
    for (const advisory of unaccepted) {
      log(`UNACCEPTED ${advisory.severity.toUpperCase()}: ${advisory.ghsa} ${advisory.package}: ${advisory.title}`);
    }
    if (unaccepted.length > 0 || expired.length > 0) {
      log(`FAIL: ${unaccepted.length} unaccepted, ${expired.length} expired.`);
      if (unaccepted.length > 0) {
        log(`Upgrade, or add a reviewed entry per advisory to ${acceptedPath} (stubs below):`);
        log(JSON.stringify(unaccepted.map(advisoryStub), null, 2));
      }
      return { exitCode: EXIT.FAIL, advisories, unaccepted, expired };
    }
    log('PASS: every high/critical advisory is accepted and within its review date.');
    return { exitCode: EXIT.PASS, advisories, unaccepted, expired };
  } catch (error) {
    return invalid(error, log);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function invalid(error, log) {
  if (!(error instanceof GateInputError)) throw error;
  log(`INVALID INPUT (failing): ${error.message}`);
  return { exitCode: EXIT.INVALID, error: error.message };
}

/** Parse argv into a mode and options. Throws GateInputError on bad usage. */
export function parseArgs(argv) {
  const options = { mode: 'sarif', inputs: [], baselinePath: 'security/baseline.json', acceptedPath: 'security/accepted-advisories.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--sarif') {
      const separator = String(value).indexOf('=');
      if (separator < 1) throw new GateInputError(`--sarif expects tool=path, got "${value}"`);
      options.inputs.push({ tool: value.slice(0, separator), file: value.slice(separator + 1) });
    } else if (flag === '--baseline') {
      options.baselinePath = value;
    } else if (flag === '--npm') {
      options.mode = 'npm';
      options.auditPath = value;
    } else if (flag === '--accepted') {
      options.acceptedPath = value;
    } else {
      throw new GateInputError(`unknown argument "${flag}"`);
    }
    i += 1;
  }
  return options;
}

function summaryLogger() {
  const lines = [];
  const log = (line) => {
    writeLine(line);
    lines.push(line);
  };
  const flush = (title) => {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) appendFileSync(summaryFile, `### ${title}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
  };
  return { log, flush };
}

/** Entry point; returns the exit code. */
export function main(argv = process.argv.slice(2)) {
  const { log, flush } = summaryLogger();
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return invalid(error, log).exitCode;
  }
  const result = options.mode === 'npm'
    ? runNpmGate({ auditPath: options.auditPath, acceptedPath: options.acceptedPath, log })
    : runSarifGate({ inputs: options.inputs, baselinePath: options.baselinePath, log });
  flush(`Security gate (${options.mode}): exit ${result.exitCode}`);
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
