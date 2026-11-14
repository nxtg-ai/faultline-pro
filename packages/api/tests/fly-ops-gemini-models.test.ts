// Validates: GoPMO 1.18.11.7.127 (ruling Dx3 15ff238e: judge gemini-3.1-pro-preview, fallback
// gemini-4-argon, live before 2026-12-01). The Fly ops action that sets the Gemini models must
// accept only models the spend ledger prices at their own rate, and must refuse anything else
// before flyctl runs. The step's own bash is run here with flyctl stubbed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { CONSENSUS_MODEL_RATES, summarizeScanUsage } from '../src/store/consensus-cost.js';

const REPO_ROOT = resolve(__dirname, '../../..');
type Step = { name?: string; if?: string; env?: Record<string, string>; run?: string };
const workflow = yaml.load(readFileSync(join(REPO_ROOT, '.github/workflows/fly-ops.yml'), 'utf8')) as {
  on: { workflow_dispatch: { inputs: Record<string, { options?: string[] }> } };
  jobs: { ops: { steps: Step[] } };
};
const step = (name: string): Step => {
  const found = workflow.jobs.ops.steps.find((s) => s.name === name);
  expect(found).toBeDefined();
  return found!;
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fly-ops-gemini-'));
  // A stub flyctl that records its arguments, one per line.
  // A stub flyctl that appends each call's arguments, one per line, then a separator line.
  writeFileSync(join(dir, 'flyctl'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${dir}/flyctl-args"\nprintf -- '---\\n' >> "${dir}/flyctl-args"\n`);
  chmodSync(join(dir, 'flyctl'), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runSet(judge: string, fallback: string, extraction: string) {
  rmSync(join(dir, 'flyctl-args'), { force: true });
  const r = spawnSync('bash', ['-e', '-c', step('Gemini models set').run!], {
    env: { PATH: `${dir}:/usr/bin:/bin`, APP: 'faultline-api', JUDGE_MODEL: judge, FALLBACK_MODEL: fallback, EXTRACTION_MODEL: extraction },
    encoding: 'utf8',
  });
  // One array of arguments per flyctl call, in order; null when flyctl never ran.
  const calls = existsSync(join(dir, 'flyctl-args'))
    ? readFileSync(join(dir, 'flyctl-args'), 'utf8').split('---\n').filter((c) => c !== '').map((c) => c.trim().split('\n'))
    : null;
  return { code: r.status, out: r.stdout + r.stderr, calls };
}

describe('fly-ops.yml: gemini-models-set', () => {
  it('is offered as an action, with its unset partner', () => {
    const options = workflow.on.workflow_dispatch.inputs.action.options!;
    expect(options).toContain('gemini-models-set');
    expect(options).toContain('gemini-models-unset');
  });

  it('allows exactly the Gemini models the spend ledger prices', () => {
    const run = step('Gemini models set').run!;
    const allowed = /PRICED="([^"]+)"/.exec(run)![1].split(' ').sort();
    const priced = Object.keys(CONSENSUS_MODEL_RATES).filter((m) => m.startsWith('gemini-')).sort();
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed).toEqual(priced);
  });

  it('reads the inputs through env, never interpolated into the script', () => {
    const s = step('Gemini models set');
    expect(s.run).not.toContain('${{');
    expect(s.env).toEqual({
      JUDGE_MODEL: '${{ inputs.judge_model }}',
      FALLBACK_MODEL: '${{ inputs.fallback_model }}',
      EXTRACTION_MODEL: '${{ inputs.extraction_model }}',
    });
  });

  it('sets all three secrets in one flyctl call for the ruled models', () => {
    const r = runSet('gemini-3.1-pro-preview', 'gemini-4-argon', 'gemini-3.5-flash-lite');
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls![0]).toEqual([
      'secrets', 'set',
      'FAULTLINE_GEMINI_MODEL=gemini-3.1-pro-preview',
      'FAULTLINE_GEMINI_FALLBACK_MODEL=gemini-4-argon',
      'FAULTLINE_GEMINI_EXTRACTION_MODEL=gemini-3.5-flash-lite',
      '-a', 'faultline-api',
    ]);
  });

  it.each([
    ['an unpriced model', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-3.5-flash-lite'],
    ['an empty fallback', 'gemini-3.1-pro-preview', '', 'gemini-3.5-flash-lite'],
    ['an injection attempt', 'gemini-3.1-pro-preview', 'gemini-4-argon; echo pwned', 'gemini-3.5-flash-lite'],
    ['a fallback equal to the judge', 'gemini-4-argon', 'gemini-4-argon', 'gemini-3.5-flash-lite'],
    ['two priced models as one judge value', 'gemini-2.5-flash gemini-3.5-flash-lite', 'gemini-4-argon', 'gemini-3.5-flash-lite'],
    ['two priced models as one fallback value', 'gemini-3.1-pro-preview', 'gemini-2.5-flash gemini-4-argon', 'gemini-3.5-flash-lite'],
    ['two priced models as one extraction value', 'gemini-3.1-pro-preview', 'gemini-4-argon', 'gemini-3.5-flash-lite gemini-2.5-flash'],
    ['a value with surrounding space', ' gemini-3.1-pro-preview', 'gemini-4-argon', 'gemini-3.5-flash-lite'],
  ])('refuses %s before flyctl runs', (_label, judge, fallback, extraction) => {
    const r = runSet(judge, fallback, extraction);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Nothing was changed.');
    expect(r.calls).toBeNull();
  });

  it('unset returns all three to the engine default', () => {
    const s = step('Gemini models unset');
    expect(s.run).toBe('flyctl secrets unset FAULTLINE_GEMINI_MODEL FAULTLINE_GEMINI_FALLBACK_MODEL FAULTLINE_GEMINI_EXTRACTION_MODEL -a "$APP"');
  });
});

describe('gemini-4-argon in the spend ledger', () => {
  it('has its list price from 2026-12-01, so the ledger never understates it', () => {
    expect(CONSENSUS_MODEL_RATES['gemini-4-argon']).toMatchObject({ inputPerM: 4.00, outputPerM: 20.00, groundingPerQuery: 0.014 });
  });

  it('prices an argon fallback judge leg at its own rate', () => {
    const usage = summarizeScanUsage([
      { model: 'gemini-4-argon', callType: 'grounded-verify:gemini', provider: 'gemini', inputTokens: 3_000, outputTokens: 100, isGrounding: false },
    ]);
    expect(usage.unratedCalls).toBe(0);
    // 3000 x 4 + 100 x 20 = 14,000 per million.
    expect(usage.costUsd).toBeCloseTo(14_000 / 1_000_000, 10);
  });
});
