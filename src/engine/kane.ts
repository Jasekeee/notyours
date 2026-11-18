// kane-cli wrapper: one authoring run per call, never retried (credits are limited).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { KaneRunSchema } from '../schemas.js';
import type { Config, Identity, KaneRun, KaneRunStatus } from '../types.js';
import { cdpEndpoint } from './chrome.js';

/** Plain strings are non-secret; pass {value, secret:true} for passwords (Kane masks them). */
export type KaneVars = Record<string, string | { value: string; secret?: boolean }>;

export interface KaneRunOptions {
  cfg: Config;
  /** .notyours directory (credits.log lives here). */
  stateDir: string;
  /** Working dir for kane-cli (it writes .testmuai/ there). Default: process.cwd(). */
  cwd?: string;
  /** kane-cli --timeout in seconds. Default 240. */
  timeoutS?: number;
  /** kane-cli --name: persist the run as .testmuai/tests/<name>_test.md for 0-credit replays (ratchet). */
  name?: string;
}

export interface KaneOutcome {
  run: KaneRun;
  /** Values the run stored (run_end.context.variables), e.g. { item_url: 'http://…' }. */
  stored: Record<string, string>;
  /** summary + one_liner + reason, for diagnostics (e.g. captcha detection). */
  text: string;
}

export type KaneRunner = (objective: string, identity: Identity, vars: KaneVars, opts: KaneRunOptions) => Promise<KaneOutcome>;

export class CreditFloorError extends Error {}

const CHILD_TIMEOUT_MS = 600_000;
const kaneBin = () => process.env.NOTYOURS_KANE_BIN ?? 'kane-cli';

export function statusFromExit(exitCode: number | undefined, timedOut: boolean): KaneRunStatus {
  if (timedOut || exitCode === 3) return 'timeout';
  if (exitCode === 0) return 'passed';
  if (exitCode === 1) return 'failed';
  return 'error';
}

interface RunEnd {
  type: 'run_end';
  status?: string;
  summary?: string;
  one_liner?: string;
  reason?: string;
  reason_code?: string;
  duration?: number;
  credits_consumed?: number;
  final_state?: Record<string, unknown>;
  test_url?: string;
  session_dir?: string;
  context?: { variables?: Record<string, { value?: unknown }> };
}

/** The last run_end event in kane-cli --agent NDJSON output. Non-JSON lines are ignored. */
export function lastRunEnd(stdout: string): RunEnd | undefined {
  let last: RunEnd | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string };
      if (ev.type === 'run_end') last = ev as RunEnd;
    } catch { /* partial line */ }
  }
  return last;
}

/** Current credit balance from `kane-cli balance`. */
export async function kaneBalance(): Promise<number> {
  const r = await execa(kaneBin(), ['balance'], { reject: false, timeout: 60_000 });
  const m = /Available credits:\s*([\d.,]+)/i.exec(`${r.stdout}\n${r.stderr}`);
  if (r.exitCode !== 0 || !m?.[1]) {
    throw new Error('Could not read the Kane credit balance. Is kane-cli installed and logged in (`kane-cli whoami`)?');
  }
  return Number(m[1].replace(/,/g, ''));
}

export async function assertCreditFloor(floor: number): Promise<number> {
  const balance = await kaneBalance();
  if (balance < floor) {
    throw new CreditFloorError(
      `Kane balance is ${balance.toFixed(1)} credits, below creditFloor ${floor}. ` +
        'Stopping before an authoring run. Top up, or lower creditFloor in .notyours/config.yaml.',
    );
  }
  return balance;
}

export function logCredits(stateDir: string, entry: Record<string, unknown>): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, 'credits.log'), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

/**
 * One authoring run as `identity`, driving that identity's Chrome over CDP.
 * Variables go through a 0600 temp file that is deleted afterwards.
 */
export const runKane: KaneRunner = async (objective, identity, vars, opts) => {
  if (opts.name !== undefined && !/^[a-zA-Z0-9_-]+$/.test(opts.name)) throw new Error(`Invalid Kane test name "${opts.name}" (allowed: [a-zA-Z0-9_-]+).`);
  await assertCreditFloor(opts.cfg.creditFloor);

  const dir = mkdtempSync(join(tmpdir(), 'ny-vars-'));
  const varsFile = join(dir, 'vars.json');
  const fileVars = Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [k, typeof v === 'string' ? { value: v } : { value: v.value, secret: v.secret ?? false }]),
  );
  const t0 = Date.now();
  let result;
  try {
    writeFileSync(varsFile, JSON.stringify(fileVars), { mode: 0o600 });
    result = await execa(
      kaneBin(),
      ['run', objective, '--agent', '--cdp-endpoint', cdpEndpoint(identity.cdpPort), '--variables-file', varsFile, '--timeout', String(opts.timeoutS ?? 240), ...(opts.name ? ['--name', opts.name] : [])],
      { reject: false, timeout: CHILD_TIMEOUT_MS, cwd: opts.cwd ?? process.cwd(), stdin: 'ignore' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const end = lastRunEnd(result.stdout ?? '');
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
  let status = statusFromExit(result.exitCode, result.timedOut);
  if (status === 'passed' && !end) status = 'error';

  const stored: Record<string, string> = {};
  for (const [k, v] of Object.entries(end?.context?.variables ?? {})) {
    if (typeof v?.value === 'string' && v.value !== '') stored[k] = v.value;
  }
  const reason = end?.reason_code ?? end?.reason ?? (end ? undefined : lastStderrLine(result.stderr ?? ''));
  const run: KaneRun = KaneRunSchema.parse({
    objective,
    identity: identity.id,
    status,
    exitCode,
    finalState: end?.final_state ?? {},
    creditsConsumed: Math.max(0, end?.credits_consumed ?? 0),
    durationS: end?.duration ?? (Date.now() - t0) / 1000,
    ...(end?.test_url ? { testUrl: end.test_url } : {}),
    ...(end?.session_dir ? { sessionDir: end.session_dir } : {}),
    ...(reason ? { reason } : {}),
  });

  logCredits(opts.stateDir, {
    kind: 'authoring',
    identity: identity.id,
    status: run.status,
    credits: run.creditsConsumed,
    durationS: run.durationS,
    wallS: (Date.now() - t0) / 1000,
    objective: objective.slice(0, 160),
  });

  return { run, stored, text: [end?.summary, end?.one_liner, end?.reason].filter(Boolean).join('\n') };
};

function lastStderrLine(stderr: string): string | undefined {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !/update available/i.test(l));
  return lines.at(-1)?.slice(0, 300);
}
