// Progress lines for long Kane runs (AUD-10): a judge running `demo --quick` saw nothing for ~4 minutes.
// The CLI entry turns this on for every command except `hook` (a hook's stderr is what the agent reads), so the
// engine, ratchet and hooks stay quiet unless a person is watching a terminal.
type Sink = (line: string) => void;
let sink: Sink | undefined;

export function setProgress(fn: Sink | undefined): void {
  sink = fn;
}

export const HEARTBEAT_MS = 30_000;

const fmt = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/** Prints "<label>: started", then a heartbeat every 30 s until `fn` settles. No sink: just runs `fn`. */
export async function withProgress<T>(label: string, fn: () => Promise<T>, everyMs = HEARTBEAT_MS): Promise<T> {
  const out = sink;
  if (!out) return fn();
  const t0 = Date.now();
  out(`  ▸ ${label}: Kane run started`);
  const timer = setInterval(() => out(`    … ${label}: still running (${fmt(Date.now() - t0)})`), everyMs);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/** A short, single-line label for a Kane objective (no newlines, capped). */
export const objectiveLabel = (identity: string, objective: string, max = 70): string => {
  const flat = objective.replace(/\s+/g, ' ').trim();
  return `${identity}: ${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}`;
};
