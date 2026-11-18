// Claude Code hooks: `notyours hook guard|post-tool|stop`, and `notyours install-hooks`.
// guard (PreToolUse): the oracle is read-only to the coding agent: no edits to locked boundaries, Kane
//   recordings, run results or config, no reading identity passwords, no self-approving new hosts.
// post-tool (PostToolUse): an edit to a boundary's `surface` marks that boundary dirty.
// stop (Stop): dirty locked boundaries are replayed (0 credits); a leak blocks the stop with the evidence.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Boundary } from '../types.js';
import { MAP_COMMAND_MD } from '../map/command.js';
import { matchesGlob } from './glob.js';
import { ownedStorePath } from './owned.js';
import { assertNoSymlinks, safeWriteFile } from './safe-fs.js';
import { NY_DIR } from './workspace.js';

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  stop_hook_active?: boolean;
}

export type GuardResult = { allow: true } | { allow: false; reason: string };

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

/** realpath of the longest existing prefix, plus the rest: resolves symlinks even for files not yet created. */
function realish(abs: string): string {
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Project-relative path with forward slashes; undefined if outside the project. */
export function relPath(root: string, p: string, cwd = root): string | undefined {
  const rel = path.relative(path.resolve(root), path.resolve(cwd, p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

/**
 * Canonical project-relative path for policy checks: symlinks resolved, lowercased (macOS/Windows
 * filesystems are case-insensitive, so .NOTYOURS/Secrets.json is the same file).
 */
export function canonRel(root: string, p: string, cwd = root): string | undefined {
  const rel = path.relative(realish(path.resolve(root)), realish(path.resolve(cwd, p)));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/').toLowerCase();
}

function toolPath(input: HookInput): string | undefined {
  const t = input.tool_input ?? {};
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof t[k] === 'string') return t[k] as string;
  return undefined;
}

const SECRET_PATHS = [`${NY_DIR}/secrets.json`, `${NY_DIR}/profiles`];
/** Recorded login tests: kane-cli writes the typed password into them (frontmatter value, `secret: true`). */
// Both where kane-cli writes them (.testmuai/tests) and where notyours keeps them (.notyours/tests).
const LOGIN_RECORDING_RE = /^(?:\.notyours|\.testmuai)\/tests\/(?:output-)?login_[^/]+/;
const LOGIN_PREFIXES = [`${NY_DIR}/tests/login_`, '.testmuai/tests/login_'];
const READONLY_PATHS = [
  `${NY_DIR}/runs`,
  `${NY_DIR}/config.yaml`,
  // Hook state and recordings: clearing dirty.json or attempts.json would let the agent skip the Stop replay.
  `${NY_DIR}/dirty.json`,
  `${NY_DIR}/attempts.json`,
  `${NY_DIR}/tests`,
  '.testmuai',
  // The hooks themselves: an agent that could edit these could switch the guard off.
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/commands/notyours-map.md',
];

/**
 * Bash segments that touch protected folders must be one of these read-only commands, with no redirects.
 * Allowlist, not denylist: anything unrecognised (interpreters, cp, sed, editors, scripts) is refused.
 */
const READONLY_BASH_RE = /^(?:ls|cat|head|tail|wc|stat|jq|grep|diff|git\s+(?:status|diff|log|show)|npx\s+notyours\s+(?:replay|report|map|doctor|run\s+--dry-run)|notyours\s+(?:replay|report|map|doctor|run\s+--dry-run))\b/;
const PROTECTED_IN_SHELL_RE = /\.notyours\b|\.testmuai\b|\.claude\/(?:settings|commands\/notyours)/;

const under = (rel: string, p: string) => rel === p || rel.startsWith(`${p}/`);
/** rel is a directory that contains p (e.g. Grep over .notyours/ would read secrets.json). Project root excluded. */
const contains = (rel: string, p: string) => rel !== '' && p.startsWith(`${rel}/`);

/** Boundary files (project-relative) whose YAML has locked: true. */
export function lockedBoundaryFiles(root: string): string[] {
  const dir = path.join(root, NY_DIR, 'boundaries');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => {
      try {
        return (YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { locked?: unknown } | null)?.locked === true;
      } catch {
        return false;
      }
    })
    .map((f) => `${NY_DIR}/boundaries/${f}`.toLowerCase());
}


/**
 * Globs the shell would expand into a dot-path (.n*, x/.t?stmuai, ">.c*"), or any unquoted brace expansion.
 * Quoted text doesn't glob in the shell, so it's checked with its metacharacters removed (jq '.items[0]' is fine),
 * but its dots still count (".n"* expands like .n*).
 */
export function hasDangerousGlob(raw: string): boolean {
  const unquoted = raw.replace(/'[^']*'|"[^"]*"/g, (m) => m.slice(1, -1).replace(/[*?[\]{}]/g, ''));
  return /(?:^|[\s/=><(;|&:])\.[^\s]*[*?[{]/.test(unquoted) || /\{[^}\s]*(?:,|\.\.)[^}\s]*\}/.test(unquoted);
}

export function guard(input: HookInput, root: string): GuardResult {
  const tool = input.tool_name ?? '';
  const cwd = input.cwd ?? root;
  const deny = (reason: string): GuardResult => ({ allow: false, reason: `notyours guard: ${reason}` });

  if (tool === 'Bash') {
    const raw = typeof input.tool_input?.command === 'string' ? (input.tool_input.command as string) : '';
    // Best-effort normalisation of shell quoting (se'cr'ets.json, se\crets.json, $'...'). This is a
    // guardrail for a cooperating agent, not a sandbox: see README.
    const cmd = raw.toLowerCase().replace(/\$'/g, "'").replace(/['"\\]/g, '');
    // Running notyours with a different home/config dir would let it read a forged owned-hosts store.
    if (/\bnotyours\b/.test(cmd) && /(?:^|[\s;&|(])(?:home|xdg_config_home|userprofile|appdata|notyours_home)=|(?:^|[\s;&|(])env\s/.test(cmd)) {
      return deny('run notyours without overriding HOME / XDG_CONFIG_HOME / USERPROFILE or via `env`.');
    }
    // Shell expansion next to a protected folder can produce any path (cat .notyours/$(...)): refuse it.
    if (PROTECTED_IN_SHELL_RE.test(cmd) && /[$`~]|\.\.\//.test(raw)) {
      return deny('commands that touch .notyours/, .testmuai/ or .claude/settings may not use $, backticks, ~ or ../');
    }
    const secretMsg = '.notyours/secrets.json and browser profiles hold identity passwords and sessions; they are off limits.';
    if (/secrets\.json|\.notyours\/profiles|owned-hosts|\.config\/notyours|login_|(?:\.notyours|\.testmuai)\/tests\/(?:output-)?log|notyours-login/.test(cmd)) return deny(secretMsg);
    // Globs at the top of .notyours/ (cat .notyours/s*) or recursive reads of the whole folder (grep -r x .notyours).
    if (/\.notyours\/[^\s/'"]*[*?[{]/.test(cmd)) return deny(secretMsg);
    if (/\.notyours\/?(?=$|[\s'";|&)])/.test(cmd) && /\b(?:grep|rg|ag|find|tar|zip|cp|rsync|cat|less|head|tail|xxd|strings|base64|scp|curl)\b/.test(cmd)) return deny(secretMsg);
    // Authoring spends Kane credits and (re)records the oracle: the human's call, never the agent's.
    if (/\bnotyours\b[^|;&]*\block\b/.test(cmd) || (/\bnotyours\b[^|;&]*\brun\b/.test(cmd) && !/\brun\b[^|;&]*--dry-run/.test(cmd))) {
      return deny('`notyours run` / `notyours lock` author Kane recordings (credits) and change the oracle: ask the user to run them. Replays are fine: npx notyours replay');
    }
    if (/\bnotyours\b[^|;&]*\binit\b[^|;&]*(?:--i-own-this|--allow-host)/.test(cmd)) {
      return deny('approving a new host (--allow-host / --i-own-this) is the human\'s decision. Ask the user to run it.');
    }
    // Globs/braces on any dot-path could expand to a protected folder (.n*, ./.t?stmuai, .{notyours,x}).
    if (hasDangerousGlob(raw)) return deny('unquoted globs or braces on dot-paths (like .n*) are not allowed: name the file explicitly.');
    // Every segment that mentions a protected folder must be an allowlisted read-only command.
    const segments = cmd.split(/&&|\|\||;|\||\n|\$\(|`/).map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      if (!PROTECTED_IN_SHELL_RE.test(seg)) continue;
      const bare = seg.replace(/^(?:[a-z_][a-z0-9_]*=\S*\s+)+/, ''); // drop VAR=value prefixes
      if (!READONLY_BASH_RE.test(bare) || /(?:^|[^<0-9&])>|<\(|-exec\b|--output\b/.test(bare)) {
        return deny(
          'in Bash, .notyours/, .testmuai/ and .claude/settings are read-only (ls, cat, grep, jq, git diff, notyours replay/report). ' +
            'Edit unlocked boundaries with the Edit/Write tools; fix the app code, then: npx notyours replay',
        );
      }
    }
    return { allow: true };
  }

  const p = toolPath(input);
  if (!p) return { allow: true };
  if (WRITE_TOOLS.has(tool) && realish(path.resolve(cwd, p)).toLowerCase().startsWith(realish(path.dirname(ownedStorePath())).toLowerCase())) {
    return deny('the owned-hosts store records the human\'s --i-own-this confirmations and is off limits.');
  }
  const rel = canonRel(root, p, cwd);
  if (rel === undefined) return { allow: true };

  const secret = SECRET_PATHS.some((s) => under(rel, s) || (READ_TOOLS.has(tool) && contains(rel, s)))
    || LOGIN_RECORDING_RE.test(rel) || (READ_TOOLS.has(tool) && LOGIN_PREFIXES.some((p) => contains(rel, p)));
  if ((READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) && secret) {
    return deny(`${rel} holds (or contains) identity passwords/sessions and is off limits. Use identity ids from .notyours/map.json.`);
  }
  if (WRITE_TOOLS.has(tool)) {
    if (READONLY_PATHS.some((s) => under(rel, s))) {
      return deny(`${rel} is part of the test oracle (recordings, results, config) and is read-only. Fix the app code, then: npx notyours replay`);
    }
    if (lockedBoundaryFiles(root).includes(rel)) {
      return deny(`${rel} is a locked boundary and is read-only. If it leaks, fix the code in its surface, not the test.`);
    }
  }
  return { allow: true };
}

export function guardOutput(r: GuardResult): string | undefined {
  if (r.allow) return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } });
}

/** Boundaries whose surface matches the edited file. */
// ---------- install ----------

interface HookCmd {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCmd[];
}
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

const OURS_RE = /\bhook (?:guard|post-tool|stop)\s*$/;

export const PERMISSION_DENY = [
  'Read(./.notyours/secrets.json)',
  'Read(./.notyours/profiles/**)',
  'Read(./.notyours/tests/login_*)',
  'Read(./.notyours/tests/output-login_*/**)',
  'Read(./.testmuai/tests/login_*)',
  'Read(./.testmuai/tests/output-login_*/**)',
  'Edit(./.notyours/secrets.json)',
  'Edit(./.notyours/config.yaml)',
  'Edit(./.notyours/runs/**)',
  'Edit(./.testmuai/**)',
  'Edit(./.notyours/dirty.json)',
  'Edit(./.notyours/attempts.json)',
  'Edit(./.notyours/tests/**)',
  'Edit(./.claude/**)',
];

/** Merge notyours hooks into Claude Code settings, replacing earlier notyours entries. */
export function mergeHookSettings(settings: Settings, cli: string): Settings {
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  const add = (event: string, group: HookGroup) => {
    const kept = (hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !(OURS_RE.test(h.command) && /notyours|cli\/index/.test(h.command))) }))
      .filter((g) => g.hooks.length > 0);
    hooks[event] = [...kept, group];
  };
  add('PreToolUse', { matcher: 'Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: `${cli} hook guard` }] });
  add('PostToolUse', { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `${cli} hook post-tool` }] });
  // 900 s: a Stop replays every dirty locked boundary (Chromes + login replays + oracle visits).
  add('Stop', { hooks: [{ type: 'command', command: `${cli} hook stop`, timeout: 900 }] });
  // Second layer, enforced by Claude Code itself: deny rules for the secrets and the oracle.
  const perms = (settings.permissions ?? {}) as { deny?: string[] } & Record<string, unknown>;
  const deny = [...new Set([...(perms.deny ?? []), ...PERMISSION_DENY])];
  return { ...settings, permissions: { ...perms, deny }, hooks };
}

export function installHooks(root: string, cli: string): { settingsFile: string; commandFile: string } {
  const dir = path.join(root, '.claude');
  const settingsFile = path.join(dir, 'settings.json');
  assertNoSymlinks(root, settingsFile);
  const current = fs.existsSync(settingsFile) ? (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Settings) : {};
  safeWriteFile(root, settingsFile, `${JSON.stringify(mergeHookSettings(current, cli), null, 2)}\n`);
  const commandFile = path.join(dir, 'commands', 'notyours-map.md');
  safeWriteFile(root, commandFile, MAP_COMMAND_MD);
  return { settingsFile, commandFile };
}
