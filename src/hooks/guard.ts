// PreToolUse (Edit|Write|MultiEdit|Bash): .notyours/ (boundaries, tests, attempts, config) is read-only for the agent.
import { toProjectPath } from './glob.js';
import { ok, projectDirOf, type HookInput, type HookResult } from './types.js';

export const GUARD_MESSAGE =
  'notyours: tests and boundaries are read-only for the agent. Fix the app\'s server-side authorization instead.';

const block = (): HookResult => ({ exitCode: 2, stderr: `${GUARD_MESSAGE}\n` });

/** `.notyours` as a path component: `.notyours`, `./.notyours/x`, `/abs/app/.notyours/x`, `".notyours/x"`. */
const NOTYOURS_PATH = /(^|[^A-Za-z0-9_.-])\.notyours(?=$|[^A-Za-z0-9_-])/;
/** Commands that rewrite recorded tests or boundaries (and spend authoring credits). Human-only. */
const MUTATING_CLI = /\bnotyours\s+lock\b/;
/** Commands that only read, so the agent may still look at evidence under .notyours/runs. */
const READ_ONLY = new Set(['cat', 'less', 'more', 'head', 'tail', 'ls', 'grep', 'egrep', 'rg', 'wc', 'stat', 'file', 'jq', 'diff', 'find', 'tree', 'du']);
const FIND_WRITES = /\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/;

function isReadOnly(command: string): boolean {
  // Any redirect that is not into /dev/null or between fds could write a file.
  const stripped = command.replace(/\d*>&\d+/g, '').replace(/\d*>>?\s*\/dev\/null/g, '');
  if (/[<>]\(|>/.test(stripped)) return false;
  if (/`|\$\(/.test(command)) return false; // command substitution: can't see what runs
  const segments = command.split(/&&|\|\||[;|\n&]/);
  for (const seg of segments) {
    if (!NOTYOURS_PATH.test(seg)) continue;
    const words = seg.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)); // skip VAR=x prefixes
    const cmd = (words[0] ?? '').replace(/^.*\//, '');
    if (!READ_ONLY.has(cmd)) return false;
    if (cmd === 'find' && FIND_WRITES.test(seg)) return false;
  }
  return true;
}

export function bashTouchesNotyours(command: string): boolean {
  if (MUTATING_CLI.test(command)) return true;
  return NOTYOURS_PATH.test(command) && !isReadOnly(command);
}

export function fileTouchesNotyours(projectDir: string, filePath: string): boolean {
  const rel = toProjectPath(projectDir, filePath);
  if (rel !== undefined) return rel === '.notyours' || rel.startsWith('.notyours/');
  // Outside the project (or unresolvable): fall back to a path-component check.
  return filePath.split(/[\\/]/).includes('.notyours');
}

export function guardHook(input: HookInput, env: NodeJS.ProcessEnv = process.env): HookResult {
  const ti = input.tool_input ?? {};
  if (input.tool_name === 'Bash' || typeof ti.command === 'string') {
    return typeof ti.command === 'string' && bashTouchesNotyours(ti.command) ? block() : ok();
  }
  const paths = [ti.file_path, ti.notebook_path, ti.path].filter((x): x is string => typeof x === 'string' && x.length > 0);
  const projectDir = projectDirOf(input, env);
  return paths.some((f) => fileTouchesNotyours(projectDir, f)) ? block() : ok();
}
