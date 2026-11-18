#!/usr/bin/env node
// Standalone hook runner: `tsx src/hooks/bin.ts <post-tool|guard|stop>` (local testing before the CLI wires `hook`).
import { runHookMain } from './index.js';

await runHookMain(process.argv[2] ?? '');
