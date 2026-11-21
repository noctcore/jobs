import { defineConfig } from 'vitest/config';

// Integration tests against a real Redis (see docker-compose.yml). They read
// REDIS_URL and REDIS_AUTH_URL; CI sets JOBS_REQUIRE_SERVICES=1 so a missing
// Redis fails the run instead of skipping it. Files run one at a time: each
// suite starts workers, and parallel files would only compete for the CPU and
// make the timing assertions noisy.
export default defineConfig({
  test: {
    include: ['tests/**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
