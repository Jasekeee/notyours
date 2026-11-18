// Thin kane-cli wrapper for the ratchet: one authoring run (`run --name`) and one replay (`testmd run`).
// Parsing is pure so tests can feed recorded NDJSON. Never retries: each call is exactly one kane-cli invocation.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { execa } from 'execa';
import type { KaneRun, KaneRunStatus } from '../types.js';

export interface AuthorRequest {
  objective: string;
  identity: string;
  /** `--name`: kane-cli writes `.testmuai/tests/<name>_test.md` under `cwd`. */
  name: string;
  cdpEndpoint: string;
  cwd: string;
  timeoutS?: number;
}

export interface ReplayRequest {
  testPath: string;
  identity: string;
  cdpEndpoint: string;
  cwd: string;
  /** Retarget the recorded start URL (`--override-start-url`). Replays ignore changed variables. */
  overrideStartUrl?: string;
  timeoutS?: number;
  /**
   * Variables for the replay, written to a 0600 temp file that is deleted afterwards. A recorded login only
   * types the right password on kane-cli 0.10.0 when the secret is supplied again at replay time.
   */
  variables?: Record<string, { value: string; secret?: boolean }>;
}

export interface ReplayOutcome {
  run: KaneRun;
  /** 1-based index of the first `## ` step that failed, if any. */
  failedStep?: number;
  /** Steps kane-cli authored instead of replaying (should be 0 with --no-adaptive-heal). */
  authorDecisions: number;
}

export interface KaneClient {
  author(req: AuthorRequest): Promise<KaneRun>;
  replay(req: ReplayRequest): Promise<ReplayOutcome>;
  /** Current credit balance, or undefined when it cannot be read. */
  balance(cwd: string): Promise<number | undefined>;
}

type Obj = Record<string, unknown>;

export function parseNdjson(stdout: string): Obj[] {
  const out: Obj[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Obj);
    } catch {
      // Non-JSON noise (update notices) is ignored.
    }
  }
  return out;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function statusFrom(raw: unknown, exitCode: number): KaneRunStatus {
  if (exitCode === 3) return 'timeout';
  if (raw === 'passed') return 'passed';
  if (raw === 'failed') return 'failed';
  return 'error';
}

/** KaneRun from a one-shot `kane-cli run --agent` stream (terminal event: `run_end`). */
export function parseAuthorRun(stdout: string, exitCode: number, objective: string, identity: string): KaneRun {
  const end = parseNdjson(stdout).findLast((e) => e.type === 'run_end');
  if (!end) {
    return { objective, identity, status: exitCode === 3 ? 'timeout' : 'error', exitCode, finalState: {}, creditsConsumed: 0, durationS: 0, reason: 'no run_end event' };
  }
  const finalState = end.final_state && typeof end.final_state === 'object' ? (end.final_state as Record<string, unknown>) : {};
  const run: KaneRun = {
    objective,
    identity,
    status: statusFrom(end.status, exitCode),
    exitCode,
    finalState,
    creditsConsumed: num(end.credits_consumed),
    durationS: num(end.duration),
  };
  const testUrl = str(end.test_url);
  const sessionDir = str(end.session_dir);
  const reason = str(end.reason_code) ?? str(end.one_liner);
  if (testUrl) run.testUrl = testUrl;
  if (sessionDir) run.sessionDir = sessionDir;
  if (reason) run.reason = reason;
  return run;
}

/** ReplayOutcome from a `kane-cli testmd run --agent` stream (terminal event: `test_md_done`). */
export function parseReplay(stdout: string, exitCode: number, testPath: string, identity: string): ReplayOutcome {
  const events = parseNdjson(stdout);
  const done = events.findLast((e) => e.type === 'test_md_done');
  const summary = events.findLast((e) => e.type === 'test_md_summary');
  const failed = events.find((e) => e.type === 'test_md_step_end' && e.status === 'failed');
  const finalState: Record<string, unknown> = {};
  let credits = 0;
  for (const e of events) {
    if (e.type !== 'run_end') continue;
    credits += num(e.credits_consumed); // replays report none; anything here means authoring happened
    if (e.final_state && typeof e.final_state === 'object') Object.assign(finalState, e.final_state);
  }
  const steps = summary?.steps && typeof summary.steps === 'object' ? (summary.steps as Obj) : {};
  const authorDecisions = num(steps.author_decisions);
  const overall = done?.overall_status ?? summary?.overall_status;
  let status = statusFrom(overall, exitCode);
  if (!done && status === 'passed') status = 'error'; // never trust a pass without the completion event
  const run: KaneRun = {
    objective: `replay ${testPath}`,
    identity,
    status,
    exitCode,
    finalState,
    creditsConsumed: credits,
    durationS: num(done?.duration_s ?? summary?.duration_s),
  };
  const sessionId = str(done?.session_id);
  if (sessionId) run.sessionDir = sessionId;
  const failedStep = typeof failed?.step_index === 'number' ? failed.step_index : undefined;
  if (!done) run.reason = 'no test_md_done event';
  else if (failedStep !== undefined) run.reason = `step ${failedStep} failed`;
  else if (status !== 'passed') run.reason = `overall_status ${String(overall)}`;
  return failedStep === undefined ? { run, authorDecisions } : { run, failedStep, authorDecisions };
}

export function parseBalance(stdout: string): number | undefined {
  const m = /credits[^0-9]*([0-9]+(?:\.[0-9]+)?)/i.exec(stdout);
  return m ? Number(m[1]) : undefined;
}

const KANE_ENV = { KANE_CLI_USER_AGENT: 'notyours' };

/** The real client. Output is parsed, never echoed: stderr can carry account details. */
export class KaneCli implements KaneClient {
  constructor(private readonly bin = 'kane-cli') {}

  async author(req: AuthorRequest): Promise<KaneRun> {
    const timeoutS = req.timeoutS ?? 300;
    const args = ['run', req.objective, '--name', req.name, '--cdp-endpoint', req.cdpEndpoint, '--agent', '--timeout', String(timeoutS)];
    const r = await execa(this.bin, args, { cwd: req.cwd, reject: false, env: KANE_ENV, timeout: (timeoutS + 60) * 1000 });
    return parseAuthorRun(String(r.stdout ?? ''), r.exitCode ?? 2, req.objective, req.identity);
  }

  async replay(req: ReplayRequest): Promise<ReplayOutcome> {
    const timeoutS = req.timeoutS ?? 120;
    // --no-adaptive-heal: a replay miss must stay a miss. Healing re-authors steps and spends credits.
    const args = ['testmd', 'run', req.testPath, '--cdp-endpoint', req.cdpEndpoint, '--agent', '--no-adaptive-heal', '--timeout', String(timeoutS)];
    if (req.overrideStartUrl) args.push('--override-start-url', req.overrideStartUrl);
    const dir = req.variables ? mkdtempSync(join(tmpdir(), 'ny-replay-')) : undefined;
    try {
      if (dir) {
        const file = join(dir, 'vars.json');
        writeFileSync(file, JSON.stringify(req.variables), { mode: 0o600 });
        args.push('--variables-file', file);
      }
      const r = await execa(this.bin, args, { cwd: req.cwd, reject: false, env: KANE_ENV, timeout: (timeoutS + 60) * 1000 });
      // Reports and run logs show the project-relative path, never an absolute local one.
      const shown = relative(req.cwd, req.testPath);
      const out = parseReplay(String(r.stdout ?? ''), r.exitCode ?? 2, shown && !shown.startsWith('..') ? shown : basename(req.testPath), req.identity);
      // Keep kane-cli's own words when it stopped before finishing (an error event, else the last stderr line).
      if (out.run.status !== 'passed' && out.run.reason === 'no test_md_done event') {
        const err = parseNdjson(String(r.stdout ?? '')).findLast((e) => e.type === 'error');
        const detail = str(err?.message) ?? str(err?.code) ?? String(r.stderr ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/update available/i.test(l)).at(-1);
        if (detail) out.run.reason = `no test_md_done event: ${detail.slice(0, 200)}`;
      }
      return out;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  async balance(cwd: string): Promise<number | undefined> {
    const r = await execa(this.bin, ['balance'], { cwd, reject: false, env: KANE_ENV, timeout: 30_000 });
    return r.exitCode === 0 ? parseBalance(String(r.stdout ?? '')) : undefined;
  }
}

export const cdpEndpoint = (port: number): string => `http://127.0.0.1:${port}`;
