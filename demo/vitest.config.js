// Demo-only test config: `npx vitest run --root demo`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
  },
});
