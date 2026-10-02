// Release-stage consistency gate (dx3-pm ruling 2026-10-02, al:2e447ee3a26d6ed9).
// One value (cli/release-stage.ts) drives `faultline version` and GET /health.
// The docs cannot import it, so this test pins them to it: promoting the stage
// is a one-value edit, and this file then names every doc still saying the old one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { RELEASE_STAGE } from '../cli/release-stage';

const repoRoot = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const TIERS = ['internal', 'dogfood', 'alpha', 'beta', 'rc', 'ga'];

describe('release stage: one value on every fp surface', () => {
  it('is a tier from the product maturity ladder', () => {
    expect(TIERS).toContain(RELEASE_STAGE);
  });

  it('`faultline version` prints the stage beside the version', async () => {
    const { main } = await import('../cli/index');
    const { exitCode, output } = await main(['version']);
    expect(exitCode).toBe(0);
    expect(output).toMatch(new RegExp(`^Faultline v\\d+\\.\\d+\\.\\d+ \\(${RELEASE_STAGE}\\)$`));
  });

  for (const readme of ['README.md', 'packages/cli/README.md']) {
    it(`${readme} carries the stage badge and stage line, and no other stage`, () => {
      const text = read(readme);
      expect(text).toContain(`badge/stage-${RELEASE_STAGE}-`);
      expect(text).toContain(`**Release stage: ${RELEASE_STAGE}.**`);
      const badges = [...text.matchAll(/badge\/stage-([a-z]+)-/g)].map((m) => m[1]);
      const lines = [...text.matchAll(/\*\*Release stage: ([a-z]+)\.\*\*/g)].map((m) => m[1]);
      expect(badges.length).toBeGreaterThan(0);
      expect(new Set([...badges, ...lines])).toEqual(new Set([RELEASE_STAGE]));
    });
  }

  it('llms.txt states the stage in its header', () => {
    const header = read('llms.txt').split('\n').slice(0, 8);
    const stageLines = header.filter((l) => l.startsWith('# Release stage: '));
    expect(stageLines).toHaveLength(1);
    expect(stageLines[0]).toMatch(new RegExp(`^# Release stage: ${RELEASE_STAGE} `));
  });

  it('CHANGELOG states the stage above the first release section', () => {
    const text = read('CHANGELOG.md');
    const top = text.slice(0, text.indexOf('## ['));
    expect(top).toContain(`**Release stage: ${RELEASE_STAGE}.**`);
  });
});
