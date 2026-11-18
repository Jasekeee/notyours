// installHooks(): merge the three notyours hooks into <project>/.claude/settings.json, keeping every other hook.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type HookName = 'post-tool' | 'guard' | 'stop';

/**
 * Claude Code hook `timeout` is in seconds (command hooks default to 600; the docs state no maximum).
 * Stop replays Kane tests and runs the oracle, so it gets 15 minutes. The other two must be quick.
 */
export const HOOK_SPECS: { name: HookName; event: 'PostToolUse' | 'PreToolUse' | 'Stop'; matcher?: string; timeout: number }[] = [
  { name: 'post-tool', event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', timeout: 10 },
  { name: 'guard', event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|Bash', timeout: 10 },
  { name: 'stop', event: 'Stop', timeout: 900 },
];

interface CommandHook {
  type: string;
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}
interface MatcherGroup {
  matcher?: string;
  hooks?: CommandHook[];
  [k: string]: unknown;
}
type Settings = { hooks?: Record<string, MatcherGroup[]>; [k: string]: unknown };

export const hookCommand = (cliCommand: string, name: HookName): string => `${cliCommand.trim()} hook ${name}`;

/** A handler we installed earlier, possibly with a different cliCommand. */
const isOurs = (h: CommandHook, name: HookName): boolean =>
  h.type === 'command' && typeof h.command === 'string' && h.command.trim().endsWith(` hook ${name}`);

/** Pure merge, exported for tests. Re-running replaces our handlers (e.g. a new cliCommand) and never duplicates them. */
export function mergeHooks(settings: Settings, cliCommand: string): Settings {
  const hooks: Record<string, MatcherGroup[]> = { ...(settings.hooks ?? {}) };
  for (const spec of HOOK_SPECS) {
    const groups = (hooks[spec.event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h, spec.name)) }));
    const kept = groups.filter((g) => g.hooks.length > 0 || !Array.isArray(g.hooks));
    const group: MatcherGroup = {
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: 'command', command: hookCommand(cliCommand, spec.name), timeout: spec.timeout }],
    };
    hooks[spec.event] = [...kept, group];
  }
  return { ...settings, hooks };
}

/** Writes the merged settings and returns the settings file path. */
export function installHooks(projectDir: string, cliCommand = 'npx --yes github:Jasekeee/notyours'): string {
  if (!cliCommand.trim()) throw new Error('notyours: cliCommand must not be empty');
  const file = path.join(projectDir, '.claude', 'settings.json');
  let settings: Settings = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    try {
      settings = text.trim() ? (JSON.parse(text) as Settings) : {};
    } catch {
      throw new Error(`notyours: ${file} is not valid JSON; not touching it`);
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(mergeHooks(settings, cliCommand), null, 2)}\n`);
  return file;
}
