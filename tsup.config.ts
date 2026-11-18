import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'cli/index': 'src/cli/index.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // No .d.ts: TypeScript 7 (native) has no JS API for rollup-plugin-dts. Run `npm run typecheck` instead.
  dts: false,
});
