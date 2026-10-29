// Validates: measurement key separation (CHANGELOG [Unreleased]): the workflows that carry the key
/**
 * Static checks on the two workflows that handle FAULTLINE_MEASUREMENT_KEY:
 * Accuracy G0 passes the repo secret to its runner (and to a branch engine), and
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

  it('passes the repo secret FAULTLINE_MEASUREMENT_KEY to the job, beside the admin key fallback', () => {
    expect(yml).toContain('FAULTLINE_MEASUREMENT_KEY: ${{ secrets.FAULTLINE_MEASUREMENT_KEY }}');
    expect(yml).toContain('FAULTLINE_ADMIN_KEY: ${{ secrets.FAULTLINE_ADMIN_KEY }}');
    expect(yml).toMatch(/::warning::Repo secret FAULTLINE_MEASUREMENT_KEY is not set.*not labelled/);
  });

  it('gives a branch engine the measurement key, so the runner can send the same key to both engines', () => {
    expect(yml).toContain('FAULTLINE_MEASUREMENT_KEY="$FAULTLINE_MEASUREMENT_KEY"');
  });

  it('keeps the branch engine spend cap at USD 28', () => {
    expect(yml).toContain('FAULTLINE_PROVIDER_SPEND_CAP_USD=28');
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
