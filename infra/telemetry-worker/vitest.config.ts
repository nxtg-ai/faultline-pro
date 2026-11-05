import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@nxtg/faultline-telemetry-worker',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
