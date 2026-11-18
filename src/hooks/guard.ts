// PreToolUse (Edit|Write|MultiEdit|Bash): .notyours/ (boundaries, tests, attempts, config) is read-only for the agent.
// This is a speed bump, not a sandbox: shell variables or an interpreter can still reach the files. The backstop
// is that .notyours/ changes show up in git, where the human reviews them.
import path from 'node:path';
import { globToRegExp, toProjectPath } from './glob.js';
import { physicalPath } from './physical.js';
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
  // The shell drops quotes and backslashes (`.not''yours`, `.noty\ours`), so match on that form too. Fail-closed:
  // the normalized form only adds matches, and isReadOnly() sees it as well.
  const norm = command.replace(/['"\\]/g, '');
  if (MUTATING_CLI.test(command) || MUTATING_CLI.test(norm)) return true;
  const mentions = [command, norm].some((c) => NOTYOURS_PATH.test(c) || globReachesNotyours(c));
  return mentions && !(isReadOnly(command) && isReadOnly(norm));
}

const hasNotyoursComponent = (p: string): boolean => p.split(/[\\/]/).some((c) => c.toLowerCase() === '.notyours');

const isNotyoursRel = (rel: string | undefined): boolean => {
  if (rel === undefined) return false;
  const first = rel.split('/')[0]?.toLowerCase();
  return first === '.notyours';
};

export function fileTouchesNotyours(projectDir: string, filePath: string): boolean {
  // Raw concatenation, not path.join: join would collapse `link/..` lexically, which is exactly the bypass.
  const abs = path.isAbsolute(filePath) ? filePath : `${projectDir}/${filePath}`;
  // Lexical check, then the symlink-resolved one (a symlink elsewhere in the tree may point into .notyours).
  if (isNotyoursRel(toProjectPath(projectDir, abs)) || hasNotyoursComponent(abs)) return true;
  let real: string;
  let realProject: string;
  try {
    real = physicalPath(abs);
    realProject = physicalPath(path.resolve(projectDir));
  } catch {
    return true; // can't tell where the write lands: fail closed
  }
  return isNotyoursRel(toProjectPath(realProject, real)) || hasNotyoursComponent(real);
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
