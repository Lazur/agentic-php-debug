import { defineConfig } from 'vitest/config';

// Real PHP + Xdebug end-to-end runs of e2e/plans/*.debugplan.json.
// Run `npm run build` first: the tests drive dist/plan/cli.js and dist/index.js.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 180_000,
    // Every plan listens on the same Xdebug port.
    fileParallelism: false,
  },
});
