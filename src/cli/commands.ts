// Real handlers behind each CLI command.
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { getEngine, getRatchet } from './backends.js';
import { sessionPool } from '../engine/index.js';
import { budgetStatus, writeBudget } from '../shared/budget.js';
import { createReport } from '../report/index.js';
import { credits, headline, isLeak, parties, verdictExplanation, verdictGroup } from '../report/summary.js';
import { fmtCredits } from '../report/html.js';
import { runMap } from '../map/index.js';
import type { Boundary, Config, Identity, ProbeResult } from '../types.js';
import { runDoctor } from './doctor.js';
export { TARGET_RE, assertHostsAllowed, boundaryUrls } from './host-gate.js';
import { assertHostsAllowed } from './host-gate.js';
import { hostOf, isLocalHost } from './hosts.js';
import { guard, guardOutput, installHooks, type HookInput } from './hooks.js';
import { postToolHook, stopHook, type HookResult } from '../hooks/index.js';
import { readPublicIdentities, runInit } from './init.js';
import type { Actions, GlobalOpts, HookEvent } from './program.js';
import { safeAppendFile } from './safe-fs.js';
import { kaneBalance, openFile } from './system.js';
import {
  UserError,
  latestResultsByBoundary,
  nyPaths,
  readBoundaries,
  readConfig,
  readConfigIfExists,
  readIdentities,
  readLatestRun,
  saveRun,
  selectBoundaries,
  type LoadedBoundary,
} from './workspace.js';

/** Typical credits for a first (authoring) Kane run per boundary; varies ~2x. Used for estimates only. */
export const CREDITS_PER_AUTHORING = 30;

const log = (s = '') => console.log(s);
const warn = (s: string) => console.error(pc.yellow(`! ${s}`));

// ---------- shared helpers ----------

function badge(r: ProbeResult): string {
  const g = verdictGroup(r.verdict);
  return g === 'LEAK' ? pc.bgRed(pc.white(pc.bold(' LEAK '))) : g === 'HELD' ? pc.bgGreen(pc.black(pc.bold(' HELD '))) : pc.bgYellow(pc.black(pc.bold(' HARNESS ')));
}

export function printResults(results: ProbeResult[], boundaries: Boundary[]): void {
  const byId = new Map(boundaries.map((b) => [b.id, b]));
  for (const r of results) {
    const p = parties(r, byId.get(r.boundaryId));
    log(`${badge(r)} ${pc.bold(r.boundaryId)}  ${verdictExplanation(r, p)} ${pc.dim(`(${fmtCredits(credits(r))} credits)`)}`);
  }
}

export function exitCodeFor(results: ProbeResult[]): number {
  return results.some((r) => verdictGroup(r.verdict) !== 'HELD') ? 1 : 0;
}

export const AGENT_OVERRIDE_ENV = 'NOTYOURS_ALLOW_AGENT_AUTHORING';

/**
 * Raising the daily authoring budget is a person's decision: `notyours budget --set` refuses from a coding agent's
 * shell (Claude Code sets CLAUDECODE=1 and gives the agent no TTY), so an agent can't raise its own cap. CI (or a
 * person scripting it) opts in with NOTYOURS_ALLOW_AGENT_AUTHORING=1, which the guard never lets the agent set.
 * Agents MAY run run/lock/demo/init/install-hooks; those are bounded by the cap instead.
 */
export function assertHuman(command: string, env: NodeJS.ProcessEnv = process.env, tty = process.stdin.isTTY === true): void {
  if (env.CLAUDECODE !== '1' || tty || env[AGENT_OVERRIDE_ENV] === '1') return;
  throw new UserError(
    `notyours ${command} raises the Kane credit budget, which is a person's decision, so it won't run from a coding agent. ` +
      `Run it yourself in a terminal (or set ${AGENT_OVERRIDE_ENV}=1 in CI).`,
  );
}

function assertIdentities(boundaries: Boundary[], identities: Identity[]): void {
  const ids = new Set(identities.map((i) => i.id));
  for (const b of boundaries) {
    for (const who of [b.owner, b.viewer]) {
      if (!ids.has(who)) throw new UserError(`Boundary ${b.id} uses identity "${who}", which is not in .notyours/secrets.json (known: ${[...ids].join(', ')})`);
    }
  }
}

/** Refuse authoring when the Kane balance is below creditFloor (project rule). */
export async function ensureCredits(cfg: Config, authoringRuns: number, balance: () => Promise<number | undefined> = kaneBalance): Promise<void> {
  const bal = await balance();
  if (bal === undefined) throw new UserError('Could not read your Kane balance (`kane-cli balance`). Run: notyours doctor');
  if (bal < cfg.creditFloor) {
    throw new UserError(`Kane balance ${bal.toFixed(0)} is below creditFloor ${cfg.creditFloor}: refusing to start authoring runs. Replays are free: notyours replay`);
  }
  const estimate = authoringRuns * CREDITS_PER_AUTHORING;
  if (bal - estimate < cfg.creditFloor) warn(`~${estimate} credits needed; this may take the balance (${bal.toFixed(0)}) below creditFloor ${cfg.creditFloor}.`);
}

interface Project {
  root: string;
  cfg: Config;
  identities: Identity[];
  all: LoadedBoundary[];
}

function loadProject(root: string): Project {
  return { root, cfg: readConfig(root), identities: readIdentities(root), all: readBoundaries(root) };
}

/** Kane and the engine resolve .testmuai/ and .notyours/ from the working directory. */
function enter(o: GlobalOpts): string {
  const root = path.resolve(o.cwd);
  if (!fs.existsSync(root)) throw new UserError(`No such directory: ${root}`);
  if (process.cwd() !== root) process.chdir(root);
  return root;
}

export interface Finished {
  runDir: string;
  reportPath: string;
  results: ProbeResult[];
}

/** Save results, write report.html/report.json next to them, print the summary. */
export function finish(root: string, command: string, startedAt: Date, results: ProbeResult[], p: Pick<Project, 'identities' | 'all'>): Finished {
  const finishedAt = new Date();
  const meta = { command, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() };
  const runDir = saveRun(root, results, meta);
  const boundaries = p.all.map((b) => b.boundary);
  const reportPath = createReport({ boundaries, identities: p.identities, baseDir: root, ...meta }).write(results, runDir);
  const h = headline(results, new Map(boundaries.map((b) => [b.id, b])));
  log();
  log(pc.bold(h.tone === 'LEAK' ? pc.red(h.title) : h.tone === 'HELD' ? pc.green(h.title) : pc.yellow(h.title)));
  const shown = path.relative(process.cwd(), reportPath);
  log(`Report: ${!shown || shown.startsWith('..') ? reportPath : shown}`);
  return { runDir, reportPath, results };
}

/** Run the engine over boundaries one at a time (each boundary uses all persona Chromes). */
export async function author(p: Project, boundaries: Boundary[]): Promise<ProbeResult[]> {
  // One logged-in Chrome per persona for the whole command (each launch logs in; replayed logins are free).
  const pool = sessionPool({ cfg: p.cfg, stateDir: nyPaths(p.root).dir, cwd: p.root });
  const engine = getEngine(p.root, pool);
  const results: ProbeResult[] = [];
  try {
    for (const b of boundaries) {
      log(pc.dim(`→ ${b.id}: ${b.owner} creates, ${b.viewer} looks`));
      // Authoring on purpose: the engine treats locked:true as judge-only, so drop it for a fresh probe.
      const { locked: _locked, ...fresh } = b;
      const t0 = Date.now();
      const r = await engine.runBoundary(fresh, p.identities, p.cfg);
      printResults([r], boundaries);
      log(pc.dim(`  ${b.id}: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.kaneRuns.reduce((n, k) => n + k.creditsConsumed, 0).toFixed(1)} credits`));
      results.push(r);
    }
  } finally {
    await pool.closeAll();
  }
  return results;
}

/** Replay locked boundaries (0 credits), optionally narrowed to ids. */
export async function replayLocked(p: Project, ids: string[]): Promise<ProbeResult[]> {
  const results = await getRatchet(p.root).replayIds(p.identities, ids.length ? ids : undefined);
  const wanted = ids.length ? results.filter((r) => ids.includes(r.boundaryId)) : results;
  const missing = ids.filter((id) => !results.some((r) => r.boundaryId === id));
  if (missing.length) warn(`Not locked, so not replayed: ${missing.join(', ')}. Lock them with: notyours lock ${missing.join(' ')}`);
  printResults(wanted, p.all.map((b) => b.boundary));
  return wanted;
}

function ensureGitignore(root: string): void {
  const lines = ['.notyours/secrets.json', '.notyours/profiles/', '.notyours/runs/', '.testmuai/evidence/'];
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file) && !fs.existsSync(path.join(root, '.git'))) return;
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = lines.filter((l) => !current.split(/\r?\n/).includes(l));
  if (missing.length) safeAppendFile(root, file, `${current && !current.endsWith('\n') ? '\n' : ''}# notyours (secrets, browser profiles, runs, Kane evidence)\n${missing.join('\n')}\n`);
}

/**
 * --i-own-this for a non-local host must be typed by a human at a terminal: a coding agent's Bash has no
 * TTY, so it can't produce this confirmation even if a hook misses the command.
 */
async function confirmOwnership(urls: string[]): Promise<void> {
  const hosts = [...new Set(urls.map((u) => hostOf(u)).filter((h) => !isLocalHost(h)))];
  if (!hosts.length) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UserError(`--i-own-this for ${hosts.join(', ')} must be confirmed interactively in a terminal.`);
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const h of hosts) {
      const answer = (await rl.question(`Type ${pc.bold(h)} to confirm you own it and may test it: `)).trim().toLowerCase();
      if (answer !== h) throw new UserError(`Not confirmed: ${h}`);
    }
  } finally {
    rl.close();
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------- actions ----------

export const actions: Actions = {
  async doctor(o) {
    const root = path.resolve(o.cwd);
    let floor = 300;
    try {
      floor = readConfigIfExists(root)?.creditFloor ?? floor;
    } catch {
      /* invalid config is reported by other commands */
    }
    const checks = await runDoctor(floor);
    for (const c of checks) {
      const mark = c.status === 'ok' ? pc.green('✓') : c.status === 'warn' ? pc.yellow('!') : pc.red('✗');
      log(`${mark} ${pc.bold(c.name)}  ${c.detail}`);
    }
    const failed = checks.filter((c) => c.status === 'fail').length;
    log();
    log(failed ? pc.red(`${failed} problem${failed === 1 ? '' : 's'} to fix.`) : pc.green('Ready.'));
    return failed ? 1 : 0;
  },

  async init(o) {
    const root = enter(o);
    if (o.iOwnThis) await confirmOwnership([o.url, ...o.allowHost.map((h) => `http://${h}`)]);
    // Keep tokens/ports from a previous init (secrets.json), else from the committed identities.json, so
    // seeded data and recorded tests stay valid. (Found by the E2E: an empty list here minted new tokens.)
    const existing: Identity[] = fs.existsSync(nyPaths(root).secrets) ? readIdentities(root) : readPublicIdentities(root);
    const r = runInit(root, { url: o.url, users: o.users, allowHost: o.allowHost, iOwnThis: o.iOwnThis }, existing);
    ensureGitignore(root);
    log(`${pc.green('✓')} .notyours/config.yaml  baseUrl ${r.baseUrl}  allowHosts ${r.allowHosts.join(', ')}`);
    log(`${pc.green('✓')} .notyours/secrets.json  ${r.identities.map((i) => `${i.id} (${i.role})`).join(', ')}  ${pc.dim('gitignored, never printed')}`);
    const noCreds = r.identities.filter((i) => i.role !== 'guest' && !i.email);
    if (noCreds.length) warn(`No login for ${noCreds.map((i) => i.id).join(', ')}. Pass --users users.yaml with email + password (or passwordEnv).`);
    log(`Next: ${pc.bold('notyours map')}, then ${pc.bold('/notyours-map')} in Claude Code to write boundaries.`);
    return 0;
  },

  async map(o) {
    const root = enter(o);
    const cfg = readConfigIfExists(root);
    let identities: Identity[] = [];
    if (fs.existsSync(nyPaths(root).secrets)) identities = readIdentities(root);
    const r = runMap({ root, baseUrl: cfg?.baseUrl, identities });
    const written = r.drafts.filter((d) => !d.skipped);
    log(`Scanned ${r.routes.length} route${r.routes.length === 1 ? '' : 's'} → .notyours/map.json`);
    for (const d of r.drafts) {
      log(`  ${d.skipped ? pc.dim('exists ') : pc.cyan('draft  ')} ${d.boundary.id}  ${pc.dim(d.routes.map((x) => `${x.method} ${x.path}`).join(', '))}`);
    }
    if (!r.drafts.length) log('No routes with an id param that read per-user data, and no plan checks, were found.');
    if (written.length) log(`\nNext: run ${pc.bold('/notyours-map')} in Claude Code to turn ${written.length} draft${written.length === 1 ? '' : 's'} into boundaries (install it with notyours install-hooks).`);
    return 0;
  },

  async run(ids, o) {
    const root = enter(o);
    const p = loadProject(root);
    const chosen = selectBoundaries(p.all, ids).map((b) => b.boundary);
    if (!chosen.length) throw new UserError('No boundaries in .notyours/boundaries/. Run `notyours map`, then /notyours-map in Claude Code.');
    assertHostsAllowed(p.cfg, chosen, root);
    assertIdentities(chosen, p.identities);
    const estimate = chosen.length * CREDITS_PER_AUTHORING;
    const cost = `~${estimate} Kane credits (authoring)`;
    log(`${chosen.length} boundar${chosen.length === 1 ? 'y' : 'ies'} against ${p.cfg.baseUrl}: ${cost}. Replays after \`notyours lock\` are free.`);
    if (o.dryRun) {
      for (const b of chosen) log(`  ${pc.bold(b.id)}  ${b.kind}: ${b.owner} → ${b.viewer}  ui ${b.targets.ui.length}, api ${b.targets.api.length}${b.locked ? pc.dim('  (locked)') : ''}`);
      log(pc.dim('Dry run: nothing started.'));
      return 0;
    }
    await ensureCredits(p.cfg, chosen.length);
    const started = new Date();
    const results = await author(p, chosen);
    finish(root, `run ${ids.join(' ')}`.trim(), started, results, p);
    return exitCodeFor(results);
  },

  async lock(ids, o) {
    const root = enter(o);
    const p = loadProject(root);
    const chosen = selectBoundaries(p.all, ids).map((b) => b.boundary);
    if (!chosen.length) throw new UserError('No boundaries to lock.');
    const started = new Date();
    let fresh: ProbeResult[] = [];
    if (o.reauthor) {
      assertHostsAllowed(p.cfg, chosen, root);
      assertIdentities(chosen, p.identities);
      await ensureCredits(p.cfg, chosen.length);
      fresh = await author(p, chosen);
    }
    const latest = latestResultsByBoundary(root);
    const ratchet = getRatchet(root);
    let locked = 0;
    for (const b of chosen) {
      const r = fresh.find((x) => x.boundaryId === b.id) ?? latest.get(b.id);
      if (!r) {
        warn(`${b.id}: no result yet. Prove it first (notyours run ${b.id}) or use --reauthor.`);
        continue;
      }
      if (r.verdict === 'HARNESS_BROKEN') {
        warn(`${b.id}: last result was HARNESS (a control failed), nothing to lock. Fix the harness and rerun.`);
        continue;
      }
      try {
        await ratchet.lock(b, r);
      } catch (e) {
        // The ratchet only locks HELD results with both controls proven (a recording of a leak proves nothing).
        warn(`${b.id}: ${(e as Error).message.replace(/^notyours: /, '')}`);
        continue;
      }
      locked++;
      log(`${pc.green('✓')} locked ${pc.bold(b.id)} ${pc.dim(`(${isLeak(r) ? 'currently LEAKS: replay after your fix' : 'held'})`)}`);
    }
    if (fresh.length) finish(root, `lock --reauthor ${ids.join(' ')}`.trim(), started, fresh, p);
    log(`${locked} locked. Replays cost 0 credits: notyours replay`);
    return locked === chosen.length ? 0 : 1;
  },

  async replay(ids, o) {
    const root = enter(o);
    const p = loadProject(root);
    const chosen = selectBoundaries(p.all, ids).map((b) => b.boundary); // also validates ids
    assertHostsAllowed(p.cfg, chosen, root);
    const started = new Date();
    const results = await replayLocked(p, ids);
    if (!results.length) {
      log('Nothing to replay. Lock proven boundaries first: notyours lock');
      return 0;
    }
    finish(root, `replay ${ids.join(' ')}`.trim(), started, results, p);
    return exitCodeFor(results);
  },

  async report(o) {
    const root = enter(o);
    const run = readLatestRun(root);
    if (!run) throw new UserError('No runs yet. Run `notyours run` or `notyours demo` first.');
    let identities: Identity[] = [];
    if (fs.existsSync(nyPaths(root).secrets)) identities = readIdentities(root);
    const boundaries = readBoundaries(root).map((b) => b.boundary);
    const reportPath = createReport({ boundaries, identities, baseDir: root, startedAt: run.meta?.startedAt, finishedAt: run.meta?.finishedAt }).write(run.results, run.dir);
    log(reportPath);
    if (o.open) openFile(reportPath);
    return 0;
  },

  async demo(o) {
    const { runDemo } = await import('./demo.js');
    return runDemo(o);
  },

  async installHooks(o) {
    const root = enter(o);
    const r = installHooks(root, o.cli);
    log(`${pc.green('✓')} ${path.relative(root, r.settingsFile)}  PreToolUse guard, PostToolUse post-tool, Stop replay  ${pc.dim(`(${o.cli} hook …)`)}`);
    log(`${pc.green('✓')} ${path.relative(root, r.commandFile)}  /notyours-map`);
    log(pc.dim('The guard keeps locked boundaries, Kane recordings, results and secrets read-only for the agent.'));
    return 0;
  },

  async budget(o) {
    const root = enter(o);
    const dir = nyPaths(root).dir;
    if (o.set !== undefined) {
      assertHuman('budget --set');
      if (!Number.isInteger(o.set) || o.set < 0) throw new UserError(`--set needs a whole number >= 0 (got ${o.set})`);
      writeBudget(dir, o.set);
      log(`${pc.green('✓')} daily authoring budget set to ${o.set} Kane runs (.notyours/budget.json)`);
    }
    const b = budgetStatus(dir);
    log(`Authoring Kane runs today: ${b.used}/${b.cap} (${b.left} left). Replays don't count. Raise it (a person): notyours budget --set N`);
    return 0;
  },

  async hook(event, o) {
    // Hooks must never break the agent's session: any internal error fails open with a note on stderr.
    try {
      const root = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? o.cwd);
      const raw = await readStdin();
      const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
      const t0 = Date.now();
      const r = await runHook(event, input, root);
      logHook(root, event, input, r, Date.now() - t0);
      // Pipes are asynchronous on macOS: wait for each write before the process exits.
      const write = (s: NodeJS.WriteStream, t: string) => new Promise<void>((res) => s.write(t, () => res()));
      if (r.stdout) await write(process.stdout, r.stdout);
      if (r.stderr) await write(process.stderr, r.stderr);
      return r.exitCode;
    } catch (e) {
      console.error(`notyours hook ${event}: ${(e as Error).message}`);
      // The guard fails closed: if it cannot decide, the tool call is blocked. post-tool and stop fail open
      // (they must never trap the agent's session).
      if (event === 'guard') {
        console.error('notyours guard: blocking this tool call because the guard itself failed (fails closed).');
        return 2;
      }
    }
    return 0;
  },
};

/**
 * One JSON line per hook call in .notyours/runs/hooks.jsonl (gitignored, read-only to the agent): what the
 * agent was shown and why it was blocked. Passwords are scrubbed; never fails the hook.
 */
export function logHook(root: string, event: HookEvent, input: HookInput, r: HookResult, ms: number): void {
  try {
    if (!fs.existsSync(nyPaths(root).config)) return;
    let ids: Identity[] = [];
    try { ids = readIdentities(root); } catch { /* no identities yet */ }
    const scrub = (t?: string) => {
      let out = (t ?? '').slice(0, 8000);
      for (const i of ids) if (i.password && i.password.length >= 4) out = out.split(i.password).join('[REDACTED]');
      return out;
    };
    const tool = typeof input.tool_name === 'string' ? input.tool_name : undefined;
    const target = typeof input.tool_input?.file_path === 'string' ? input.tool_input.file_path : typeof input.tool_input?.command === 'string' ? input.tool_input.command.slice(0, 300) : undefined;
    const line = { ts: new Date().toISOString(), event, tool, target: target ? scrub(target) : undefined, exitCode: r.exitCode, ms, stdout: scrub(r.stdout), stderr: scrub(r.stderr) };
    safeAppendFile(root, path.join(nyPaths(root).runs, 'hooks.jsonl'), `${JSON.stringify(line)}\n`);
  } catch { /* logging must never break the agent's session */ }
}

/**
 * Hook dispatch. guard: the CLI's hardened guard (canonical paths, Bash allowlist, hook config read-only).
 * post-tool / stop: the ratchet's hooks (dirty set with file + glob evidence; Stop replays the dirty locked
 * boundaries for 0 credits, exits 2 with a leak report, escalates to the human after 3 attempts).
 */
export async function runHook(event: HookEvent, input: HookInput, root: string): Promise<HookResult> {
  if (event === 'guard') {
    const out = guardOutput(guard(input, root));
    return { exitCode: 0, ...(out ? { stdout: `${out}\n` } : {}) };
  }
  const withCwd = { ...input, cwd: typeof input.cwd === 'string' ? input.cwd : root };
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  if (event === 'post-tool') return postToolHook(withCwd, env);
  // The host gate (allowHosts + owned hosts) runs inside RealRatchet.replayIds, per app folder, fail closed.
  return stopHook(withCwd, { env });
}
