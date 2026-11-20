import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'demo/test/**/*.test.js'],
    // spike/ and the agent worktrees (../notyours-*) are never collected.
    exclude: ['node_modules', 'dist', 'spike'],
    // App-start approvals are isolated in-process (test/vitest-setup.ts), never the real ~/.config/notyours.
    setupFiles: ['test/vitest-setup.ts'],
  },
});
