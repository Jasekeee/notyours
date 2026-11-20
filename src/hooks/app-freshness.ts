// Stale-app guard for the Stop hook (experiment 2: the hook replayed against a server started before the edit, so its
// GREEN judged old code). Before replaying:
//   app.start set   -> only if a person approved exactly this (start, port) for this project on this machine
//                      (hooks/app-approval.ts, kept in the user's config folder); otherwise YELLOW
//                      with the approve command. Approved: restart the app (stop whatever listens on its port, run
//                      app.start, wait until the port answers).
//   app.start unset -> compare the listening process's start time with the newest surface file; code newer -> YELLOW,
//                      no replay, exit 2, so the agent restarts the server.
// `app` lives in .notyours/config.yaml next to the frozen ConfigSchema fields (zod strips unknown keys, so the
// existing parsers ignore it); it is read here with its own schema.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Boundary } from '../types.js';
import type { NotyoursPaths } from '../ratchet/paths.js';
import { surfaceFingerprints } from './surface-scan.js';
import { isAppStartApproved } from './app-approval.js';

export const AppSettingsSchema = z.object({
  /** Shell command that starts the app, run in the app folder (e.g. `node server.js`, `PORT=4001 npm start`). */
  start: z.string().trim().min(1).optional(),
  /** Port the app listens on. Default: the baseUrl port. */
  port: z.number().int().min(1).max(65535).optional(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const STALE_MESSAGE = 'your app server is older than your code — restart it or set app.start';

/** The `app:` block of .notyours/config.yaml ({} when absent or invalid). */
export function readAppSettings(p: NotyoursPaths): AppSettings {
  try {
    const raw = YAML.parse(readFileSync(p.config, 'utf8')) as { app?: unknown } | null;
    const r = AppSettingsSchema.safeParse(raw?.app ?? {});
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

export function appPort(app: AppSettings, baseUrl: string): number {
  if (app.port) return app.port;
  const u = new URL(baseUrl);
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
}

/** `ps -o etime` → seconds. Formats: mm:ss, hh:mm:ss, d-hh:mm:ss. */
export function parseEtime(s: string): number | undefined {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(s);
  if (!m) return undefined;
  const [, d, h, mm, ss] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
}

export interface FreshnessDeps {
  /** PIDs listening on the TCP port (empty: none; undefined: can't tell, e.g. no lsof). */
  listeners(port: number): number[] | undefined;
  /** How long the process has been running, in seconds (undefined: unknown). */
  ageSeconds(pid: number): number | undefined;
  now(): number;
  /** Restart the app: stop the listeners on `port`, run `start` in `appDir`, wait until the port answers. */
  restart(appDir: string, start: string, port: number, host: string, logFile: string): Promise<void>;
  /** Does anything accept connections on host:port? */
  answers(host: string, port: number): Promise<boolean>;
}

function tryExec(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch (e) {
    // lsof exits 1 when nothing matches: that's "no listener", not "unknown".
    const err = e as { status?: number; stdout?: string; code?: string };
    if (err.code === 'ENOENT') return undefined;
    return err.stdout ?? '';
  }
}

export const listenersOn = (port: number): number[] | undefined => {
  const out = tryExec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return out === undefined ? undefined : [...new Set(out.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0))];
};

const ageOf = (pid: number): number | undefined => {
  const out = tryExec('ps', ['-o', 'etime=', '-p', String(pid)]);
  return out ? parseEtime(out) : undefined;
};

/** Resolves once something accepts TCP connections on host:port, or rejects after `timeoutMs`. */
export function waitForPort(host: string, port: number, timeoutMs = 30_000, exited?: () => string | undefined): Promise<void> {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const why = exited?.();
      if (why) return reject(new Error(why));
      const s = net.connect({ host, port });
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > end) reject(new Error(`nothing answered on ${host}:${port} within ${Math.round(timeoutMs / 1000)}s`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tail = (file: string, lines = 8): string => {
  try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; }
};

export interface RestartDeps {
  /** PIDs listening on the port (undefined: can't tell, e.g. no lsof). */
  listeners?: (port: number) => number[] | undefined;
  /** How long to wait for the port to be free after stopping the old server. */
  stopWaitMs?: number;
}

/** One connection attempt: does anything accept TCP connections on host:port right now? */
export function portAnswers(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    // Close politely (FIN, read what the server sends) so the probe never resets a running app's connection.
    s.on('connect', () => { done(true); s.end(); s.resume(); });
    s.on('error', () => done(false)); // refused; later errors after connect are ignored
    s.setTimeout(timeoutMs, () => { done(true); s.destroy(); }); // filtered or silent: treat as "something is there"
    s.on('close', () => done(false));
  });
}

/**
 * Restart the app (audit P0-3): stop the old server, require the port to be FREE (connection refused) before
 * starting app.start, then require that a NEW process answers. Anything else throws, which the Stop hook reports
 * as YELLOW (restart-failed) and never replays: a replay must not judge the old server's code.
 */
export async function restartApp(appDir: string, start: string, port: number, host: string, logFile: string, timeoutMs = 30_000, deps: RestartDeps = {}): Promise<void> {
  const listeners = deps.listeners ?? listenersOn;
  const stopWaitMs = deps.stopWaitMs ?? 5_000;
  // 1. Stop the old server (only processes listening on the app's own port; lsof shows only this user's).
  const old = listeners(port);
  for (const pid of old ?? []) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  const freeBy = Date.now() + stopWaitMs;
  while ((await portAnswers(host, port)) && Date.now() < freeBy) await sleep(100);
  if (await portAnswers(host, port)) {
    for (const pid of listeners(port) ?? []) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(300);
  }
  if (await portAnswers(host, port)) {
    const who = old === undefined ? 'notyours cannot see which process holds it (no lsof)'
      : old.length ? `pid ${old.join(', ')} did not stop` : "it is held by a process notyours cannot see (another user's, or a container's)";
    throw new Error(`:${port} still answers after stopping the old server: ${who}. Stop that server yourself; notyours will not replay against it.`);
  }
  // 2. Start the new one, detached, so it outlives this hook process.
  const fd = openSync(logFile, 'a');
  let exitedWith: string | undefined;
  try {
    const child = spawn('/bin/sh', ['-c', start], { cwd: appDir, detached: true, stdio: ['ignore', fd, fd] });
    child.on('exit', (code, sig) => { exitedWith = `app.start exited (${sig ?? `code ${code}`}) before port ${port} answered`; });
    child.unref();
  } finally {
    closeSync(fd);
  }
  // 3. Wait until it answers.
  try {
    await waitForPort(host, port, timeoutMs, () => exitedWith);
  } catch (e) {
    const log = tail(logFile);
    throw new Error(`${(e as Error).message}${log ? `\n  last lines of ${path.basename(logFile)}:\n  ${log.split('\n').join('\n  ')}` : ''}`);
  }
  // 4. The port was free before the start, so whoever answers now is new, unless lsof still shows an old pid there.
  const now = listeners(port);
  const survivors = (now ?? []).filter((pid) => (old ?? []).includes(pid));
  if (survivors.length) throw new Error(`:${port} answers, but from pid ${survivors.join(', ')}, which was listening before the restart: not a new process. Not replaying.`);
}

export const defaultFreshnessDeps: FreshnessDeps = { listeners: listenersOn, ageSeconds: ageOf, now: () => Date.now(), restart: restartApp, answers: (host, port) => portAnswers(host, port) };

export type Freshness =
  | { status: 'fresh'; note?: string }
  | { status: 'restarted'; note: string }
  | { status: 'stale' | 'unverified' | 'restart-failed' | 'unapproved'; message: string };

/** The command a person runs in a terminal to approve app.start (the wizard shows the command and asks first). */
export const APPROVE_COMMAND = 'npx notyours init';

const hhmmss = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/** Newest mtime (ms) among the files under the boundaries' surfaces, and which file it is. */
export function newestSurfaceFile(appDir: string, boundaries: Boundary[]): { file: string; mtimeMs: number } | undefined {
  let best: { file: string; mtimeMs: number } | undefined;
  for (const f of Object.keys(surfaceFingerprints(appDir, boundaries).files)) {
    try {
      const m = statSync(path.join(appDir, f)).mtimeMs;
      if (!best || m > best.mtimeMs) best = { file: f, mtimeMs: m };
    } catch { /* deleted since */ }
  }
  return best;
}

/** Decide whether the Stop hook may replay against the running app (and restart it when app.start is set). */
export async function checkAppFreshness(
  appDir: string, p: NotyoursPaths, baseUrl: string, boundaries: Boundary[], deps: FreshnessDeps = defaultFreshnessDeps,
): Promise<Freshness> {
  const app = readAppSettings(p);
  const port = appPort(app, baseUrl);
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
  if (app.start) {
    // Same check as the agent-run init: only the start command and port a person approved on this machine.
    if (!isAppStartApproved(path.dirname(p.dir), app.start, port)) {
      return {
        status: 'unapproved',
        message:
          `notyours: YELLOW. app.start \`${app.start}\` (port ${port}) has not been approved on this machine, so notyours won't run it. Not replaying.\n` +
          '  A person approves it once, in a terminal in this folder:\n' +
          `    ${APPROVE_COMMAND}\n` +
          '  The wizard shows the command and asks before approving. Then stop again.',
      };
    }
    try {
      await deps.restart(appDir, app.start, port, host, path.join(p.dir, 'app.log'));
      return { status: 'restarted', note: `notyours: restarted the app (app.start) on :${port} before replaying.` };
    } catch (e) {
      return { status: 'restart-failed', message: `notyours: YELLOW. Could not restart the app with app.start on :${port}: ${(e as Error).message}. Not replaying.` };
    }
  }
  // Without app.start: replay only when the running server provably started after the newest surface edit
  // (audit P1-08). Anything that can't be verified is YELLOW, never a replay as if fresh.
  const pids = deps.listeners(port);
  if (pids === undefined) return unverified(port, 'notyours cannot see which process listens on it (no lsof)');
  if (!pids.length) {
    if (await deps.answers(host, port)) return unverified(port, "the port answers, but from a process notyours cannot see (another user's, or a container's)");
    return {
      status: 'unverified',
      message: `notyours: YELLOW. nothing answers on :${port}. Start your app server (in the background), then stop again.\n` +
        '  A person can set `app.start` in .notyours/config.yaml so the Stop hook starts it automatically.',
    };
  }
  const newest = newestSurfaceFile(appDir, boundaries);
  if (!newest) return { status: 'fresh' };
  const ages = pids.map((pid) => deps.ageSeconds(pid)).filter((a): a is number => a !== undefined);
  if (!ages.length) return unverified(port, `the start time of pid ${pids.join(', ')} can't be read`);
  // The youngest listener counts; etime has 1 s resolution, so allow 2 s.
  const startedMs = deps.now() - Math.min(...ages) * 1000;
  if (newest.mtimeMs <= startedMs + 2000) return { status: 'fresh' };
  return {
    status: 'stale',
    message:
      `notyours: YELLOW. ${STALE_MESSAGE}.\n` +
      `  The server on :${port} (pid ${pids.join(', ')}) started at ${hhmmss(startedMs)}, but ${newest.file} changed at ${hhmmss(newest.mtimeMs)}.\n` +
      '  Not replaying: the result would judge the old code.\n' +
      '  Restart the app server (stop the old process, start it again in the background), then stop again so notyours can replay.\n' +
      '  A person can set `app.start` in .notyours/config.yaml so the Stop hook restarts it automatically.',
  };
}

function unverified(port: number, why: string): Freshness {
  return {
    status: 'unverified',
    message:
      `notyours: YELLOW. can't verify the server is current on :${port}: ${why}.\n` +
      '  Not replaying: the result could judge old code.\n' +
      '  Restart the app server yourself, then stop again; or a person sets `app.start` in .notyours/config.yaml (and\n' +
      '  approves it once in a terminal) so the Stop hook restarts it before every replay.',
  };
}

/** True when the app folder has an `app.start` that exists as a config entry (for doctor/README hints). */
export const hasAppStart = (p: NotyoursPaths): boolean => existsSync(p.config) && !!readAppSettings(p).start;
