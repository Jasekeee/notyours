// Fail-closed hook launching. `.claude/settings.json` never points at a CLI path directly (an npx cache path can vanish,
// and a hook command that can't start is a NON-blocking error in Claude Code, i.e. the guard would fail open).
// Instead every hook command runs a small launcher, `.notyours/bin/notyours-hook`, which finds the CLI:
//   1. the --cli command given to install-hooks
//   2. the project's own node_modules/.bin/notyours
//   3. the CLI that ran install-hooks (absolute path; ~0.2 s per start), while it still exists
//   4. `notyours` on PATH
//   5. npx --yes notyours@<the installed version> (pinned; 5–9 s per start, but it works)
// If none is found, or the CLI exits with anything but 0 or 2, the hook exits 2 (blocking) with HOOK_UNAVAILABLE.
// The one exception is the Stop hook's loop protection: with stop_hook_active it reports and lets the stop through.
import fs from 'node:fs';
import pkg from '../../package.json' with { type: 'json' };

export const HOOK_WRAPPER = '.notyours/bin/notyours-hook';
export const HOOK_UNAVAILABLE = 'notyours guard unavailable — run `npx notyours install-hooks` (or doctor)';
/** The npx fallback runs exactly the version that installed the hooks, never a moving target. */
export const PINNED_NPX = `npx --yes notyours@${pkg.version}`;
export type LaunchedHook = 'guard' | 'post-tool' | 'stop';

/** POSIX single-quote a string for sh. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The CLI file that is running now, if it is a built .js file (not tsx in dev). */
export function selfCliPath(argv1: string | undefined = process.argv[1]): string | undefined {
  try {
    const self = argv1 ? fs.realpathSync(argv1) : '';
    return /\.[cm]?js$/.test(self) ? self : undefined;
  } catch {
    return undefined;
  }
}

/** The command written to .claude/settings.json. Blocks (exit 2) even when the launcher itself is missing. */
export function hookLauncherCommand(event: LaunchedHook): string {
  const run = `f="\${CLAUDE_PROJECT_DIR:-.}/${HOOK_WRAPPER}"; [ -f "$f" ] && exec /bin/sh "$f" ${event}; echo ${shq(HOOK_UNAVAILABLE)} >&2;`;
  // Stop: keep Claude Code's loop protection. A second stop in a row (stop_hook_active) is let through, with the note.
  return event === 'stop' ? `${run} grep -q '"stop_hook_active" *: *true' && exit 0; exit 2` : `${run} exit 2`;
}

/** The launcher script, written to HOOK_WRAPPER (mode 0755) by install-hooks. */
export function hookLauncherScript(opts: { cli?: string; selfJs?: string }): string {
  return `#!/bin/sh
# notyours hook launcher, written by \`notyours install-hooks\`. Do not edit; rerun install-hooks instead.
# Fails CLOSED: when no notyours CLI can be started, or it crashes, the hook exits 2 (blocking).
msg=${shq(HOOK_UNAVAILABLE)}
custom=${shq(opts.cli?.trim() ?? '')}
baked=${shq(opts.selfJs ?? '')}
root="$(cd "$(dirname "$0")/../.." && pwd)"

resolve() {
  if [ -n "$custom" ]; then echo custom; return 0; fi
  if [ -x "$root/node_modules/.bin/notyours" ]; then echo local; return 0; fi
  if [ -n "$baked" ] && [ -f "$baked" ] && command -v node >/dev/null 2>&1; then echo baked; return 0; fi
  if command -v notyours >/dev/null 2>&1; then echo path; return 0; fi
  if [ -z "$NOTYOURS_HOOK_NO_NPX" ] && command -v npx >/dev/null 2>&1; then echo npx; return 0; fi
  return 1
}

describe() {
  case "$1" in
    custom) echo "$custom" ;;
    local) echo "$root/node_modules/.bin/notyours" ;;
    baked) echo "node $baked" ;;
    path) command -v notyours ;;
    npx) echo "${PINNED_NPX} (slow: 5-9 s per hook call)" ;;
  esac
}

if [ "$1" = --resolve ]; then
  how="$(resolve)" || { echo "$msg (no notyours CLI found)" >&2; exit 2; }
  describe "$how"
  exit 0
fi

event="$1"
case "$event" in guard|post-tool|stop) ;; *) echo "$msg (unknown hook: $event)" >&2; exit 2 ;; esac
input="$(cat)"
fail() {
  echo "$msg ($1)" >&2
  # Stop's loop protection: never trap the session in a stop loop.
  if [ "$event" = stop ]; then
    case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;; esac
  fi
  exit 2
}

how="$(resolve)" || fail "no notyours CLI found"
case "$how" in
  custom) printf '%s' "$input" | eval "$custom hook $event" ;;
  local) printf '%s' "$input" | "$root/node_modules/.bin/notyours" hook "$event" ;;
  baked) printf '%s' "$input" | node "$baked" hook "$event" ;;
  path) printf '%s' "$input" | notyours hook "$event" ;;
  npx) printf '%s' "$input" | ${PINNED_NPX} hook "$event" ;;
esac
rc=$?
case "$rc" in 0|2) exit "$rc" ;; esac
fail "the notyours CLI failed with exit $rc: $(describe "$how")"
`;
}
