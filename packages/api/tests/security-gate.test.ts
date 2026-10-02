// Validates: security-scan.yml ratchet (docs/security/2026-10-02-security-evidence-v0.11.1.md §8)
/**
 * scripts/security-gate.mjs: the ratchet behind .github/workflows/security-scan.yml.
 *
 * Fixtures mirror the real scanner output of run 37062617182: the level lives on
 * tool.driver.rules[].defaultConfiguration, NOT on the result, and semgrep OSS
 * results carry no partialFingerprints. A fixture with result.level set would
 * pass while the real gate saw nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  runSarifGate,
  runNpmGate,
  locationFingerprint,
  normalizeUri,
} from '../../../scripts/security-gate.mjs';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/security-gate.mjs');

let dir: string;
let lines: string[];
const log = (line: string) => lines.push(line);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'security-gate-'));
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

type Result = Record<string, unknown>;

/** A bearer result shaped like run 37062617182 (no level, line-hash fingerprint). */
function bearerResult(ruleId: string, uri: string, line: number, lineHash: string): Result {
  return {
    ruleId,
    message: { text: 'Usage of hard-coded secret' },
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line, startColumn: 3, endLine: line, endColumn: 46 } } }],
    partialFingerprints: { primaryLocationLineHash: lineHash },
  };
}

/** A semgrep OSS result: no level, no partialFingerprints, constant matchBasedId. */
function semgrepResult(ruleId: string, uri: string, line: number, message: string): Result {
  return {
    ruleId,
    message: { text: message },
    fingerprints: { 'matchBasedId/v1': 'requires login' },
    locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' }, region: { startLine: line } } }],
  };
}

function sarif(driverName: string, rules: [string, string][], results: Result[], extraRun: Record<string, unknown> = {}) {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: driverName, rules: rules.map(([id, level]) => ({ id, defaultConfiguration: { level } })) } },
      results,
      ...extraRun,
    }],
  };
}

const BEARER_RULES: [string, string][] = [
  ['javascript_lang_hardcoded_secret', 'error'],
  ['javascript_lang_logger_leak', 'error'],
];
const SEMGREP_RULES: [string, string][] = [
  ['yaml.github-actions.security.run-shell-injection.run-shell-injection', 'error'],
  ['javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring', 'warning'],
];

const SECRET = bearerResult('javascript_lang_hardcoded_secret', 'packages/api/benchmarks/run.ts', 287, '44e1718cb08d5e4f1e9848f86e648085_0');
const SHELL_INJECTION = semgrepResult(
  'yaml.github-actions.security.run-shell-injection.run-shell-injection',
  '.github/workflows/release-protocol-check.yml', 46,
  'Using variable interpolation `${{...}}` with `github` context data in a `run:` step could allow an attacker to inject their own code.',
);

function entry(tool: string, ruleId: string, uri: string, fp: string) {
  return { tool, ruleId, uri, fp, disposition: 'accepted-pre-existing', reason: 'test fixture' };
}
const SECRET_ENTRY = entry('bearer', 'javascript_lang_hardcoded_secret', 'packages/api/benchmarks/run.ts', '44e1718cb08d5e4f1e9848f86e648085_0');

function gate(bearerResults: Result[], baselineEntries: unknown[], semgrepResults: Result[] = []) {
  const bearerFile = write('bearer.sarif', sarif('Bearer', BEARER_RULES, bearerResults));
  const semgrepFile = write('semgrep.sarif', sarif('Semgrep OSS', SEMGREP_RULES, semgrepResults));
  const baselinePath = write('baseline.json', { entries: baselineEntries });
  return runSarifGate({
    inputs: [{ tool: 'semgrep', file: semgrepFile }, { tool: 'bearer', file: bearerFile }],
    baselinePath,
    root: '/repo',
    log,
  });
}

describe('security-gate SARIF ratchet', () => {
  it('SG-01 a new blocking finding (level from the rule default) fails with exit 1 and names tool, rule, file:line', () => {
    const r = gate([SECRET], []);
    expect(r.exitCode).toBe(1);
    expect(r.newFindings).toHaveLength(1);
    expect(lines).toContain(
      'NEW BLOCKING: bearer javascript_lang_hardcoded_secret packages/api/benchmarks/run.ts:287 fp=44e1718cb08d5e4f1e9848f86e648085_0',
    );
  });

  it('SG-02 a baselined finding passes with exit 0', () => {
    const r = gate([SECRET], [SECRET_ENTRY]);
    expect(r.findings).toHaveLength(1);
    expect(r.exitCode).toBe(0);
    expect(r.newFindings).toEqual([]);
  });

  it('SG-03 the same finding on a moved line keeps its fingerprint and passes', () => {
    const moved = bearerResult('javascript_lang_hardcoded_secret', 'packages/api/benchmarks/run.ts', 912, '44e1718cb08d5e4f1e9848f86e648085_0');
    const r = gate([moved], [SECRET_ENTRY]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].line).toBe(912);
    expect(r.exitCode).toBe(0);
  });

  it('SG-04 semgrep (no partialFingerprints) is keyed on the message, so a moved line passes and a new rule hit fails', () => {
    const fp = locationFingerprint(SHELL_INJECTION);
    expect(fp).toMatch(/^msg:[0-9a-f]{32}$/);
    const semgrepEntry = entry('semgrep', SHELL_INJECTION.ruleId as string, '.github/workflows/release-protocol-check.yml', fp);
    const moved = { ...SHELL_INJECTION, locations: [{ physicalLocation: { artifactLocation: { uri: '.github/workflows/release-protocol-check.yml' }, region: { startLine: 99 } } }] };
    expect(gate([], [semgrepEntry], [moved]).exitCode).toBe(0);
    lines = [];
    const r = gate([], [], [SHELL_INJECTION]);
    expect(r.exitCode).toBe(1);
    expect(lines.some((l) => l.startsWith('NEW BLOCKING: semgrep yaml.github-actions.security.run-shell-injection'))).toBe(true);
  });

  it('SG-05 non-blocking levels (rule default warning) never fail', () => {
    const warning = semgrepResult('javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring', 'packages/cli/cli/scan.ts', 10, 'format string');
    const r = gate([], [], [warning]);
    expect(r.findings).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it('SG-06 an explicit result.level overrides the rule default', () => {
    const downgraded = { ...SECRET, level: 'note' };
    expect(gate([downgraded], []).exitCode).toBe(0);
    const upgraded = { ...semgrepResult('javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring', 'a.ts', 1, 'm'), level: 'error' };
    expect(gate([], [], [upgraded]).exitCode).toBe(1);
  });

  it('SG-07 a semgrep in-source suppression (# nosemgrep) is not blocking', () => {
    const suppressed = { ...SHELL_INJECTION, suppressions: [{ kind: 'inSource' }] };
    expect(gate([], [], [suppressed]).exitCode).toBe(0);
    const rejected = { ...SHELL_INJECTION, suppressions: [{ kind: 'external', status: 'rejected' }] };
    expect(gate([], [], [rejected]).exitCode).toBe(1);
  });

  it('SG-08 baseline is a multiset: a second copy of a baselined finding is new', () => {
    const copy = { ...SECRET, locations: [{ physicalLocation: { artifactLocation: { uri: 'packages/api/benchmarks/run.ts' }, region: { startLine: 300 } } }] };
    const r = gate([SECRET, copy], [SECRET_ENTRY]);
    expect(r.exitCode).toBe(1);
    expect(r.newFindings).toHaveLength(1);
  });

  it('SG-09 a baseline entry no longer found is reported stale but does not fail', () => {
    const r = gate([], [SECRET_ENTRY]);
    expect(r.exitCode).toBe(0);
    expect(r.stale).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('STALE (not failing): bearer javascript_lang_hardcoded_secret'))).toBe(true);
  });

  it('SG-10 the same rule in a different file is new', () => {
    const elsewhere = bearerResult('javascript_lang_hardcoded_secret', 'packages/api/src/new.ts', 287, '44e1718cb08d5e4f1e9848f86e648085_0');
    expect(gate([elsewhere], [SECRET_ENTRY]).exitCode).toBe(1);
  });

  it('SG-11 absolute and file:// URIs normalise to the repo-relative path', () => {
    expect(normalizeUri('file:///repo/packages/a.ts', '/repo')).toBe('packages/a.ts');
    expect(normalizeUri('/repo/packages/a.ts', '/repo')).toBe('packages/a.ts');
    expect(normalizeUri('./packages/a.ts', '/repo')).toBe('packages/a.ts');
    const absolute = bearerResult('javascript_lang_hardcoded_secret', 'file:///repo/packages/api/benchmarks/run.ts', 287, '44e1718cb08d5e4f1e9848f86e648085_0');
    expect(gate([absolute], [SECRET_ENTRY]).exitCode).toBe(0);
  });
});

describe('security-gate refuses input it cannot trust (exit 2)', () => {
  const baseline = () => write('baseline.json', { entries: [] });
  const run = (file: string, tool = 'bearer') => runSarifGate({ inputs: [{ tool, file }], baselinePath: baseline(), log });

  it('SG-20 a missing SARIF file fails with exit 2', () => {
    expect(run(join(dir, 'nope.sarif')).exitCode).toBe(2);
    expect(lines.some((l) => l.startsWith('INVALID INPUT (failing): bearer SARIF not found'))).toBe(true);
  });

  it('SG-21 unparseable or empty SARIF fails with exit 2', () => {
    expect(run(write('bad.sarif', '{"runs": [')).exitCode).toBe(2);
    expect(run(write('empty.sarif', '')).exitCode).toBe(2);
    expect(run(write('noruns.sarif', { version: '2.1.0', runs: [] })).exitCode).toBe(2);
  });

  it('SG-22 a run that loaded no rules, or reported executionSuccessful=false, fails with exit 2', () => {
    expect(run(write('norules.sarif', sarif('Bearer', [], []))).exitCode).toBe(2);
    const crashed = sarif('Bearer', BEARER_RULES, [], { invocations: [{ executionSuccessful: false }] });
    expect(run(write('crashed.sarif', crashed)).exitCode).toBe(2);
  });

  it('SG-23 SARIF from the wrong tool fails with exit 2', () => {
    const semgrepFile = write('semgrep.sarif', sarif('Semgrep OSS', SEMGREP_RULES, []));
    expect(run(semgrepFile, 'bearer').exitCode).toBe(2);
    expect(lines.some((l) => l.includes('produced by "Semgrep OSS", not bearer'))).toBe(true);
  });

  it('SG-24 a baseline entry without a reason fails with exit 2', () => {
    const file = write('bearer.sarif', sarif('Bearer', BEARER_RULES, []));
    const badBaseline = write('baseline.json', { entries: [{ ...SECRET_ENTRY, reason: '' }] });
    expect(runSarifGate({ inputs: [{ tool: 'bearer', file }], baselinePath: badBaseline, log }).exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// npm audit mode
// ---------------------------------------------------------------------------

function audit(vias: Record<string, unknown>[]) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      'adm-zip': { name: 'adm-zip', severity: 'high', via: vias, effects: [] },
      // A transitive entry whose via is a package name, as npm emits.
      parent: { name: 'parent', severity: 'high', via: ['adm-zip'], effects: [] },
    },
    metadata: { vulnerabilities: { high: 1, critical: 0 }, dependencies: { prod: 308, dev: 293, total: 627 } },
  };
}
const HIGH = { source: 1, name: 'adm-zip', title: 'adm-zip: Crafted ZIP file triggers 4GB memory allocation', url: 'https://github.com/advisories/GHSA-xcpc-8h2w-3j85', severity: 'high', range: '<0.6.0' };
const MODERATE = { ...HIGH, title: 'moderate one', url: 'https://github.com/advisories/GHSA-vwc7-r8mq-g2x9', severity: 'moderate' };
const accept = (review_by: string) => ({
  ghsa: 'GHSA-xcpc-8h2w-3j85', package: 'adm-zip', severity: 'high', disposition: 'accepted-not-reachable', reason: 'test', review_by,
});

function npmGate(vias: Record<string, unknown>[], accepted: unknown[], today = '2026-10-02') {
  return runNpmGate({ auditPath: write('audit.json', audit(vias)), acceptedPath: write('accepted.json', accepted), today, log });
}

describe('security-gate npm audit mode', () => {
  it('SG-30 an unaccepted high advisory fails with exit 1 and prints a paste-ready stub', () => {
    const r = npmGate([HIGH, MODERATE], []);
    expect(r.exitCode).toBe(1);
    expect(r.advisories.map((a: { ghsa: string }) => a.ghsa)).toEqual(['GHSA-xcpc-8h2w-3j85']);
    expect(lines).toContain('UNACCEPTED HIGH: GHSA-xcpc-8h2w-3j85 adm-zip: adm-zip: Crafted ZIP file triggers 4GB memory allocation');
    expect(lines.some((l) => l.includes('"ghsa": "GHSA-xcpc-8h2w-3j85"'))).toBe(true);
  });

  it('SG-31 an accepted advisory within review_by passes with exit 0', () => {
    const r = npmGate([HIGH], [accept('2026-12-31')]);
    expect(r.advisories).toHaveLength(1);
    expect(r.exitCode).toBe(0);
  });

  it('SG-32 an accepted advisory past review_by fails with exit 1', () => {
    const r = npmGate([HIGH], [accept('2026-10-01')]);
    expect(r.exitCode).toBe(1);
    expect(r.expired).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('EXPIRED: GHSA-xcpc-8h2w-3j85'))).toBe(true);
  });

  it('SG-33 review_by equal to today is still valid', () => {
    expect(npmGate([HIGH], [accept('2026-10-02')]).exitCode).toBe(0);
  });

  it('SG-34 moderate and low advisories do not block', () => {
    const r = npmGate([MODERATE], []);
    expect(r.advisories).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it('SG-35 critical blocks like high', () => {
    expect(npmGate([{ ...HIGH, severity: 'critical' }], []).exitCode).toBe(1);
  });

  it('SG-36 an npm error report or a non-v2 report fails with exit 2', () => {
    const acceptedPath = write('accepted.json', []);
    const errorReport = write('err.json', { error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } });
    expect(runNpmGate({ auditPath: errorReport, acceptedPath, log }).exitCode).toBe(2);
    expect(runNpmGate({ auditPath: write('v1.json', { auditReportVersion: 1, advisories: {} }), acceptedPath, log }).exitCode).toBe(2);
    expect(runNpmGate({ auditPath: join(dir, 'missing.json'), acceptedPath, log }).exitCode).toBe(2);
  });

  it('SG-38 an audit that saw no production dependencies fails with exit 2 (vacuous pass)', () => {
    const empty = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: {}, dependencies: { prod: 0, total: 0 } } };
    const r = runNpmGate({ auditPath: write('empty.json', empty), acceptedPath: write('accepted.json', []), log });
    expect(r.exitCode).toBe(2);
    expect(lines.some((l) => l.includes('saw no production dependencies'))).toBe(true);
  });

  it('SG-37 an accepted entry with a malformed review_by fails with exit 2', () => {
    expect(npmGate([HIGH], [accept('soon')]).exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Real process exit codes and the committed data files
// ---------------------------------------------------------------------------

describe('security-gate CLI and committed files', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });

  it('SG-40 the process exits 1 on a new finding, 0 when baselined, 2 on a missing file', () => {
    const bearerFile = write('bearer.sarif', sarif('Bearer', BEARER_RULES, [SECRET]));
    expect(cli('--sarif', `bearer=${bearerFile}`, '--baseline', write('b0.json', { entries: [] })).status).toBe(1);
    expect(cli('--sarif', `bearer=${bearerFile}`, '--baseline', write('b1.json', { entries: [SECRET_ENTRY] })).status).toBe(0);
    expect(cli('--sarif', `bearer=${join(dir, 'gone.sarif')}`, '--baseline', write('b2.json', { entries: [] })).status).toBe(2);
    expect(cli('--bogus', 'x').status).toBe(2);
  });

  it('SG-41 the process exits 1 on an unaccepted advisory', () => {
    const r = cli('--npm', write('audit.json', audit([HIGH])), '--accepted', write('accepted.json', []));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('UNACCEPTED HIGH: GHSA-xcpc-8h2w-3j85');
  });

  it('SG-42 security/baseline.json is valid: 99 bearer entries, every one with a disposition and reason', () => {
    const baseline = JSON.parse(readFileSync(join(REPO_ROOT, 'security/baseline.json'), 'utf8'));
    expect(baseline.entries.length).toBe(99);
    for (const e of baseline.entries) {
      expect(e.tool).toBe('bearer');
      expect(e.disposition).toMatch(/^(accepted-pre-existing|false-positive|open)$/);
      expect(e.reason.length).toBeGreaterThan(10);
      expect(e.fp).not.toMatch(/^\d+$/);
    }
    const specific = baseline.entries.filter((e: { disposition: string }) => e.disposition !== 'accepted-pre-existing');
    expect(specific).toHaveLength(8);
    expect(specific.filter((e: { reason: string }) => e.reason.startsWith('OPEN:'))).toHaveLength(4);
  });

  it('SG-43 security/accepted-advisories.json is a valid (empty) list', () => {
    expect(JSON.parse(readFileSync(join(REPO_ROOT, 'security/accepted-advisories.json'), 'utf8'))).toEqual([]);
  });
});
