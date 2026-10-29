// Validates: measurement key separation (CHANGELOG [Unreleased]): the workflows that carry the key
/**
 * Static checks on the two workflows that handle FAULTLINE_MEASUREMENT_KEY:
 * Accuracy G0 passes the repo secret to its deployed-mode runner only (never to a
 * branch engine or a branch-mode runner, which keep the USD 28 spend cap), and
 * Fly ops sets it from the secret through env, refusing an empty secret before
 * flyctl runs. Neither ever echoes the value.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const read = (file: string) => readFileSync(join(REPO_ROOT, '.github/workflows', file), 'utf8');

describe('accuracy-g0.yml: the measurement key', () => {
  const yml = read('accuracy-g0.yml');

  const step = (name: string) => {
    const start = yml.indexOf(`- name: ${name}\n`);
    expect(start).toBeGreaterThan(-1);
    const next = yml.indexOf('\n      - ', start + 1);
    return yml.slice(start, next === -1 ? undefined : next);
  };
  const jobEnv = yml.slice(yml.indexOf('    env:\n      SET:'), yml.indexOf('    steps:\n'));

  it('keeps the measurement key out of the job-level env, so no step inherits it', () => {
    expect(jobEnv).toContain('FAULTLINE_ADMIN_KEY: ${{ secrets.FAULTLINE_ADMIN_KEY }}');
    expect(jobEnv).not.toContain('FAULTLINE_MEASUREMENT_KEY');
  });

  it('deployed mode: the key check reads the secret and warns when only the admin key is set', () => {
    const check = step('Require a key secret (deployed mode)');
    expect(check).toContain("if: inputs.engine == 'deployed'");
    expect(check).toContain('FAULTLINE_MEASUREMENT_KEY: ${{ secrets.FAULTLINE_MEASUREMENT_KEY }}');
    expect(check).toMatch(/::warning::Repo secret FAULTLINE_MEASUREMENT_KEY is not set.*not labelled/);
  });

  it('branch mode: requires the admin key and never reads the measurement key', () => {
    const check = step('Require the admin key secret (branch mode)');
    expect(check).toContain("if: inputs.engine == 'branch'");
    expect(check).toContain('if [ -z "$FAULTLINE_ADMIN_KEY" ]');
    expect(check).not.toContain('FAULTLINE_MEASUREMENT_KEY');
  });

  it('branch mode: the branch engine gets no measurement key and keeps its USD 28 spend cap on the admin key', () => {
    const engine = step('Start the branch engine');
    expect(engine).toContain("if: inputs.engine == 'branch'");
    expect(engine).not.toContain('FAULTLINE_MEASUREMENT_KEY');
    expect(engine).toContain('FAULTLINE_API_KEY="$FAULTLINE_ADMIN_KEY"');
    expect(engine).toContain('FAULTLINE_PROVIDER_SPEND_CAP=on FAULTLINE_PROVIDER_SPEND_CAP_USD=28');
  });

  it('the runner step: the deployed run receives the secret, the branch run does not', () => {
    const runner = step('Run');
    // The step env holds the secret only when the engine is deployed; the branch value is empty.
    expect(runner).toContain("FAULTLINE_MEASUREMENT_KEY: ${{ inputs.engine == 'deployed' && secrets.FAULTLINE_MEASUREMENT_KEY || '' }}");
    const branchCall = runner.split('\n').find((line) => line.includes('--api http://127.0.0.1:3010'));
    expect(branchCall).toBeDefined();
    expect(branchCall!.trim().startsWith('env -u FAULTLINE_MEASUREMENT_KEY node scripts/accuracy-g0.mjs')).toBe(true);
    const deployedCall = runner.split('\n').find((line) => line.trim() === 'node scripts/accuracy-g0.mjs --set "$SET" --out "$OUT"');
    expect(deployedCall).toBeDefined();
    // The only measurement-key text in the workflow is in the deployed-mode check and the runner step.
    const mentions = yml.split('\n').filter((line) => line.includes('secrets.FAULTLINE_MEASUREMENT_KEY'));
    expect(mentions).toHaveLength(2);
  });

  it('never echoes a key', () => {
    expect(yml).not.toMatch(/echo[^\n]*\$\{?FAULTLINE_(MEASUREMENT|ADMIN)_KEY/);
  });
});

describe('fly-ops.yml: measurement-key-set and measurement-key-unset', () => {
  const yml = read('fly-ops.yml');
  const step = (name: string) => {
    const start = yml.indexOf(`- name: ${name}`);
    expect(start).toBeGreaterThan(-1);
    const next = yml.indexOf('\n      - ', start + 1);
    return yml.slice(start, next === -1 ? undefined : next);
  };

  it('offers both actions', () => {
    expect(yml).toContain('          - measurement-key-set\n');
    expect(yml).toContain('          - measurement-key-unset\n');
  });

  it('set: reads the secret through env, refuses an empty one before flyctl runs, and never echoes it', () => {
    const set = step('Measurement key set');
    expect(set).toContain("if: inputs.action == 'measurement-key-set'");
    expect(set).toContain('MEASUREMENT_KEY: ${{ secrets.FAULTLINE_MEASUREMENT_KEY }}');
    const guard = set.indexOf('if [ -z "$MEASUREMENT_KEY" ]');
    const flyctl = set.indexOf('flyctl secrets set FAULTLINE_MEASUREMENT_KEY="$MEASUREMENT_KEY" -a "$APP"');
    expect(guard).toBeGreaterThan(-1);
    expect(flyctl).toBeGreaterThan(guard);
    expect(set.slice(guard, flyctl)).toContain('exit 1');
    expect(set).not.toMatch(/echo[^\n]*\$\{?MEASUREMENT_KEY/);
    // The secret never appears inline in the run script.
    expect(set.slice(set.indexOf('run: |'))).not.toContain('secrets.');
  });

  it('unset: removes the secret only', () => {
    const unset = step('Measurement key unset');
    expect(unset).toContain("if: inputs.action == 'measurement-key-unset'");
    expect(unset).toContain('flyctl secrets unset FAULTLINE_MEASUREMENT_KEY -a "$APP"');
  });
});
