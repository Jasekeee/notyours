// Terminal output shared by every command: plain lines, step lines with elapsed time and a credit estimate,
// a summary table, the "how to fix" line for errors, and --json for agents and CI (one JSON object on stdout).
import pc from 'picocolors';

let json = false;

/** Turn on --json: plain lines are suppressed and the command prints one JSON object instead. */
export function setJsonMode(on: boolean): void {
  json = on;
}

export const isJsonMode = (): boolean => json;

/** A normal output line. Silent in --json mode (the command emits its JSON object instead). */
export function say(line = ''): void {
  if (!json) console.log(line);
}

/** Warnings go to stderr, so they show up even in --json mode without corrupting the JSON on stdout. */
export function warn(line: string): void {
  console.error(pc.yellow(`! ${line}`));
}

/** The one JSON object of a --json run. */
export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export const fmtSeconds = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

export interface Step {
  /** Finish the step: prints the check line with elapsed time and, if given, the credits spent. */
  done(detail?: string, credits?: number): void;
  /** Mark the step as failed (the caller throws the error and its fix line). */
  fail(detail?: string): void;
}

/**
 * "▸ label  (~N credits)" before a step that may spend Kane credits, then "✓ label  12s  14.0 credits" after.
 * The estimate is printed before the work starts, so a person can stop the run before the credits are spent.
 */
export function step(label: string, estimateCredits?: number): Step {
  const t0 = Date.now();
  const est = estimateCredits !== undefined ? pc.dim(`  (~${estimateCredits} credits)`) : '';
  say(`▸ ${label}${est}`);
  return {
    done(detail, credits) {
      const spent = credits !== undefined ? `, ${credits.toFixed(1)} credits` : '';
      say(`${pc.green('✓')} ${label}  ${pc.dim(`${fmtSeconds(Date.now() - t0)}${spent}`)}${detail ? `  ${detail}` : ''}`);
    },
    fail(detail) {
      say(`${pc.red('✗')} ${label}  ${pc.dim(fmtSeconds(Date.now() - t0))}${detail ? `  ${detail}` : ''}`);
    },
  };
}

/** Left-aligned plain-text table (no box drawing: it survives copy-paste and CI logs). */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsiLen(r[i] ?? ''))));
  const pad = (cell: string, i: number) => cell + ' '.repeat(Math.max(0, widths[i]! - stripAnsiLen(cell)));
  const line = (cells: string[]) => cells.map(pad).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const stripAnsiLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;

/** Fallback fix line for an error that doesn't carry its own. */
export const DEFAULT_FIX = 'run `notyours doctor` to check this machine and the project, then retry (add --debug for the stack).';

/** The last line of every error: what the person (or agent) should do next. */
export function fixLine(fix: string | undefined): string {
  return `  how to fix: ${fix ?? DEFAULT_FIX}`;
}

/** Two-column "key  value" lines with aligned values (no header row). */
export function kv(rows: Array<[string, string]>): string {
  const w = Math.max(0, ...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`).join('\n');
}
