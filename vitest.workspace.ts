/**
 * Vitest workspace configuration — N-18 React Workspace Split.
 *
 * Running `vitest run` from the monorepo root delegates to each package's
 * own vitest.config.ts. All package tests are discovered and run together.
 *
 * packages/cli  → @nxtg/faultline  (909+ CLI tests, no React)
 * packages/web  → @nxtg/faultline-web  (web/React tests)
 * packages/api  → @nxtg/faultline-api  (N-13 Cloud Platform API, Fastify)
 *
 * vitest v4 removed defineWorkspace — workspace files export an array directly.
 */
export default [
  'packages/cli',
  'packages/web',
  'packages/api',
];
