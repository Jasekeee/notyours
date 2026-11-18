// PreToolUse (Edit|Write|MultiEdit|Bash): .notyours/ (boundaries, tests, attempts, config) is read-only for the agent.
// This is a speed bump, not a sandbox: shell variables or an interpreter can still reach the files. The backstop
// is that .notyours/ changes show up in git, where the human reviews them.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { globToRegExp, toProjectPath } from './glob.js';
import { ok, projectDirOf, type HookInput, type HookResult } from './types.js';

export const GUARD_MESSAGE =
  'notyours: tests and boundaries are read-only for the agent. Fix the app\'s server-side authorization instead.';

const block = (): HookResult => ({ exitCode: 2, stderr: `${GUARD_MESSAGE}\n` });

/** `.notyours` as a path component, any case (macOS filesystems are case-insensitive). */
const NOTYOURS_PATH = /(^|[^A-Za-z0-9_.-])\.notyours(?=$|[^A-Za-z0-9_-])/i;
/** Commands that rewrite recorded tests or boundaries (and spend authoring credits). Human-only. */
const MUTATING_CLI = /\bnotyours\s+lock\b/;
/** Commands with no flag that writes a file or runs another program. */
const READ_ONLY = new Set(['cat', 'less', 'more', 'head', 'tail', 'ls', 'grep', 'egrep', 'fgrep', 'wc', 'stat', 'jq', 'diff', 'find', 'du']);
const FIND_WRITES = /\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/;

/**
 * A shell glob word (`.n*`, `.noty?ours`, `.[n]otyours/x`) that would expand to .notyours. Shell globs only
 * match dotfiles when the pattern itself starts with a literal `.`, so `rm build/*` is not caught here.
 */
function globReachesNotyours(command: string): boolean {
  for (const word of command.split(/[\s;|&()<>'"`]+/)) {
    for (const part of word.split('/')) {
      if (!part.startsWith('.') || !/[*?[{]/.test(part)) continue;
      try {
        if (globToRegExp(part.toLowerCase()).test('.notyours')) return true;
      } catch {
        return true; // unparsable glob on a dot-path: be safe
      }
    }
  }
  return false;
}

function isReadOnly(command: string): boolean {
  // Any redirect that is not into /dev/null or between fds could write a file.
  const stripped = command.replace(/\d*>&\d+/g, '').replace(/\d*>>?\s*\/dev\/null/g, '');
  if (/[<>]\(|>/.test(stripped)) return false;
  if (/`|\$\(|\$\{|\$[A-Za-z_]/.test(command)) return false; // substitutions/variables: can't see what runs
  // Every command in the line must be read-only: `ls .notyours | xargs rm` names .notyours only in the first part.
  for (const seg of stripped.split(/&&|\|\||[;|\n&]/)) {
    const words = seg.trim().split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)); // skip VAR=x prefixes
    if (!words.length) continue;
    const cmd = (words[0] ?? '').replace(/^.*\//, '');
    if (!READ_ONLY.has(cmd)) return false;
    if (cmd === 'find' && FIND_WRITES.test(seg)) return false;
  }
  return true;
}

export function bashTouchesNotyours(command: string): boolean {
  if (MUTATING_CLI.test(command)) return true;
  const mentions = NOTYOURS_PATH.test(command) || globReachesNotyours(command);
  return mentions && !isReadOnly(command);
}

/** realpath of the nearest existing ancestor, plus the not-yet-existing rest (Write creates new files). */
function realish(p: string): string {
  let head = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    rest.unshift(path.basename(head));
    head = parent;
  }
  try {
    head = realpathSync(head);
  } catch {
    // keep the lexical path
  }
  return path.join(head, ...rest);
}

const isNotyoursRel = (rel: string | undefined): boolean => {
  if (rel === undefined) return false;
  const first = rel.split('/')[0]?.toLowerCase();
  return first === '.notyours';
};

export function fileTouchesNotyours(projectDir: string, filePath: string): boolean {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(projectDir, filePath);
  // Lexical check, then the symlink-resolved one (a symlink elsewhere in the tree may point into .notyours).
  if (isNotyoursRel(toProjectPath(projectDir, abs))) return true;
  if (isNotyoursRel(toProjectPath(realish(projectDir), realish(abs)))) return true;
  // Outside the project: fall back to a path-component check.
  return abs.split(/[\\/]/).some((c) => c.toLowerCase() === '.notyours');
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
