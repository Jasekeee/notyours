import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // spike/ and the agent worktrees (../notyours-*) are never collected.
    exclude: ['node_modules', 'dist', 'spike'],
  },
});
