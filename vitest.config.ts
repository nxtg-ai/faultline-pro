/**
 * Root Vitest config. `vitest run` at the monorepo root runs these four
 * package projects, each with its own vitest.config.ts.
 *
 * Vitest 4 ignores vitest.workspace.ts, so without this file root discovery
 * walked the whole tree, including agent git worktrees under
 * .claude/worktrees/, and the pre-push gate ran (and failed on) their
 * half-finished copies of the suite (2026-10-02).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/cli', 'packages/web', 'packages/api', 'packages/mcp'],
  },
});
