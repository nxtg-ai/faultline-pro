import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: [
        'cli/**',
        'providers/**',
        'analysis/**',
        'compliance/**',
        'history/**',
        'rules/**',
        'templates/**',
        'types.ts',
      ],
      exclude: ['node_modules', 'dist'],
    },
  },
});
