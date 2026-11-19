import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'demo/test/**/*.test.js'],
    // spike/ and the agent worktrees (../notyours-*) are never collected.
    exclude: ['node_modules', 'dist', 'spike'],
    // App-start approvals go to the user's config folder; tests use their own, never the real ~/.config/notyours.
    env: { NOTYOURS_CONFIG_HOME: path.join(os.tmpdir(), `notyours-test-config-${process.pid}`) },
  },
});
