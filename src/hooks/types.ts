/** What a hook asks the process to do. The runner writes stdout/stderr and exits with exitCode. */
export interface HookResult {
  exitCode: 0 | 2;
  stdout?: string;
  stderr?: string;
  /** Work was abandoned at the Stop hook's own deadline and may still be running: the CLI exits right away. */
  abandoned?: boolean;
}

/** The subset of the Claude Code hook stdin JSON the notyours hooks read. */
export interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
    [k: string]: unknown;
  };
  stop_hook_active?: boolean;
  [k: string]: unknown;
}

export const ok = (): HookResult => ({ exitCode: 0 });

/** Exit 0 with a message for the human (Claude Code shows `systemMessage` to the user, not to Claude). */
export const tellHuman = (message: string): HookResult => ({
  exitCode: 0,
  stdout: `${JSON.stringify({ systemMessage: message })}\n`,
});

export function parseHookInput(raw: string): HookInput {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as HookInput) : {};
  } catch {
    return {};
  }
}

/** The project root: CLAUDE_PROJECT_DIR (set by Claude Code for command hooks), else the input's cwd. */
export function projectDirOf(input: HookInput, env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}
