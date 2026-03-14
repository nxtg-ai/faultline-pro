import { defineWorkspace } from 'vitest/config';

/**
 * Vitest workspace configuration — N-18 React Workspace Split.
 *
 * Running `vitest run` from the monorepo root delegates to each package's
 * own vitest.config.ts. All package tests are discovered and run together.
 *
 * packages/cli  → @nxtg/faultline  (909+ CLI tests, no React)
 * packages/web  → @nxtg/faultline-web  (web/React tests)
 */
export default defineWorkspace([
  'packages/cli',
  'packages/web',
]);
