import { defineConfig } from 'vitest/config';

// Fast unit and type tests: no network, no Redis.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.int.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary'],
    },
  },
});
