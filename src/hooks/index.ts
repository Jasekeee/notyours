// Hook entry points. The CLI wires `notyours hook <name>` to runHookMain() via registerHookCommands().
import type { Command } from 'commander';
import { guardHook } from './guard.js';
import { postToolHook } from './post-tool.js';
import { stopHook } from './stop.js';
import { parseHookInput, type HookResult } from './types.js';

/** The hooks `notyours hook <name>` runs. (Installing them: src/cli/hooks.ts installHooks + the fail-closed launcher.) */
export type HookName = 'post-tool' | 'guard' | 'stop';
export { guardHook, GUARD_MESSAGE, bashTouchesNotyours } from './guard.js';
export { postToolHook, matchBoundaries } from './post-tool.js';
export { stopHook, formatLeakReport, LAST_LINE, MAX_REPORT_LINES, type StopDeps } from './stop.js';
export { matchesGlob, globToRegExp } from './glob.js';
export { markSurfaceChanges, writeSurfaceBaseline, changedSurfaceFiles } from './surface-scan.js';
export type { HookInput, HookResult } from './types.js';

export const HOOK_NAMES: HookName[] = ['post-tool', 'guard', 'stop'];

export async function runHook(name: HookName, rawInput: string): Promise<HookResult> {
  const input = parseHookInput(rawInput);
  if (name === 'post-tool') return postToolHook(input);
  if (name === 'guard') return guardHook(input);
  return stopHook(input);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads the hook JSON from stdin, runs the hook, writes its output and exits with its code. */
export async function runHookMain(name: string): Promise<never> {
  if (!HOOK_NAMES.includes(name as HookName)) {
    process.stderr.write(`notyours: unknown hook "${name}" (expected ${HOOK_NAMES.join(', ')})\n`);
    process.exit(1);
  }
  let r: HookResult;
  try {
    r = await runHook(name as HookName, await readStdin());
  } catch (e) {
    // A crash must never trap the agent: report to the human and let the action go ahead.
    r = { exitCode: 0, stdout: `${JSON.stringify({ systemMessage: `notyours ${name} hook error: ${(e as Error).message}` })}\n` };
  }
  // Pipes are asynchronous on macOS: wait for each write to flush before exiting, or output gets cut off.
  if (r.stdout) await write(process.stdout, r.stdout);
  if (r.stderr) await write(process.stderr, r.stderr);
  process.exit(r.exitCode);
}

const write = (s: NodeJS.WriteStream, text: string) => new Promise<void>((res) => s.write(text, () => res()));

/** Adds `hook <name>` to a commander program. Call from src/cli/index.ts. */
export function registerHookCommands(program: Command): void {
  program
    .command('hook')
    .description(`Claude Code hook entry point (${HOOK_NAMES.join(' | ')}); reads hook JSON on stdin`)
    .argument('<name>', HOOK_NAMES.join(' | '))
    .action(async (name: string) => {
      await runHookMain(name);
    });
}
