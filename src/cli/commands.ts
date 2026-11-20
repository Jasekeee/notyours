// Real handlers behind each CLI command.
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { getEngine, getRatchet } from './backends.js';
import { sessionPool } from '../engine/index.js';
import { budgetStatus, writeBudget } from '../shared/budget.js';
import { emitJson, isJsonMode, say, table, warn } from './output.js';
import { runWizard, summaryLines, type WizardDeps } from './wizard.js';
import { detectProject } from './detect.js';
import { isUp, startApp } from './app-process.js';
import { appPort, readAppSettings } from '../hooks/app-freshness.js';
import { approveStart, isApprovedFor, isStartApproved } from './app-approval.js';
import { computeStatus, renderStatus } from './status.js';
import { launchChrome } from '../engine/chrome.js';
import { runKane } from '../engine/kane.js';
import { signup } from '../engine/signup.js';
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
import { postToolHook, stopHook, writeSurfaceBaseline, type HookResult } from '../hooks/index.js';
import { notyoursPaths } from '../ratchet/paths.js';
import { estimateAuthoring, estimateLine } from './estimate.js';
import { ownPagesFor } from '../ratchet/ratchet.js';
import { readAttempts, readDirty, readEscalated, writeAttempts, writeDirty, writeEscalated } from '../ratchet/store.js';
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

const log = say;

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
/** Inside Claude Code: CLAUDECODE is set (any value, even 0 or empty) or any CLAUDE_CODE_* variable is present. */
export const inCodingAgent = (env: NodeJS.ProcessEnv): boolean =>
  env.CLAUDECODE !== undefined || Object.keys(env).some((k) => k.startsWith('CLAUDE_CODE_'));

export function assertHuman(command: string, env: NodeJS.ProcessEnv = process.env, tty = process.stdin.isTTY === true, what = 'raises the Kane credit budget'): void {
  if (!inCodingAgent(env) || tty || env[AGENT_OVERRIDE_ENV] === '1') return;
  throw new UserError(
    `notyours ${command} ${what}, which is a person's decision, so it won't run from a coding agent. ` +
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
    throw new UserError(`Kane balance ${bal.toFixed(0)} is below creditFloor ${cfg.creditFloor}: refusing to start authoring runs. Replays need no authoring runs (about 0–1 credit each): notyours replay`);
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
  const shown = path.relative(process.cwd(), reportPath);
  const report = !shown || shown.startsWith('..') ? reportPath : shown;
  const rows = summaryRows(results);
  if (isJsonMode()) {
    emitJson({ ok: exitCodeFor(results) === 0, headline: h.title, results: rows, report, runDir, exitCode: exitCodeFor(results) });
  } else {
    log();
    log(table(['boundary', 'verdict', 'time', 'credits'], rows.map((r) => [r.boundary, r.verdict, `${Math.round(r.seconds)} s`, r.credits.toFixed(1)])));
    log();
    log(pc.bold(h.tone === 'LEAK' ? pc.red(h.title) : h.tone === 'HELD' ? pc.green(h.title) : pc.yellow(h.title)));
    log(`Report: ${report}`);
  }
  return { runDir, reportPath, results };
}

/** One row per boundary for the summary table: verdict, Kane time and credits (summed over its Kane runs). */
export function summaryRows(results: ProbeResult[]): Array<{ boundary: string; verdict: string; seconds: number; credits: number }> {
  return results.map((r) => ({
    boundary: r.boundaryId,
    verdict: r.verdict,
    seconds: r.kaneRuns.reduce((n, k) => n + k.durationS, 0),
    credits: credits(r),
  }));
}

/** Run the engine over boundaries one at a time (each boundary uses all persona Chromes). */
export async function author(p: Project, boundaries: Boundary[]): Promise<ProbeResult[]> {
  // One logged-in Chrome per persona for the whole command (each launch logs in; replayed logins need no authoring run).
  // Personas still signed in (their own page shows their token) skip the login replay: replaying a login while
  // signed in fails on apps that redirect /login away, and a failed one would cost a re-recording here.
  const pool = sessionPool({ cfg: p.cfg, stateDir: nyPaths(p.root).dir, cwd: p.root, ownPages: ownPagesFor(boundaries) });
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

/**
 * Runs `fn` with the app answering. If nothing answers and config.yaml has app.start (the wizard writes it), starts
 * the app, runs `fn`, then stops the app. No app.start: `fn` runs and the engine says the app is not reachable.
 */
export async function withApp<T>(root: string, cfg: Config, fn: () => Promise<T>): Promise<T> {
  const app = readAppSettings(notyoursPaths(root));
  if (!app.start || (await isUp(cfg.baseUrl))) return fn();
  // config.yaml is committed and can come from a clone or an agent's shell: run only what the person approved here.
  if (!isStartApproved(root, app, cfg.baseUrl)) {
    throw new UserError(
      `app.start in .notyours/config.yaml (${app.start}) has not been approved on this machine, so notyours will not run it.`,
      'run `notyours init` in a terminal to review and approve it, or start the app yourself and rerun this command.',
    );
  }
  const port = appPort(app, cfg.baseUrl);
  const handle = await startApp(app.start, root, port, cfg.baseUrl).catch((e: Error) => {
    throw new UserError(`The app did not start with app.start (${app.start}): ${e.message}`, `run \`${app.start}\` in another terminal, then rerun this command.`);
  });
  log(pc.dim(`started the app with app.start (${app.start}); it stops when this command ends`));
  try {
    return await fn();
  } finally {
    await handle.stop();
  }
}

/** Replay locked boundaries (no authoring runs), optionally narrowed to ids. */
export async function replayLocked(p: Project, ids: string[]): Promise<ProbeResult[]> {
  const results = await getRatchet(p.root).replayIds(p.identities, ids.length ? ids : undefined);
  const wanted = ids.length ? results.filter((r) => ids.includes(r.boundaryId)) : results;
  const missing = ids.filter((id) => !results.some((r) => r.boundaryId === id));
  if (missing.length) warn(`Not locked, so not replayed: ${missing.join(', ')}. Lock them with: notyours lock ${missing.join(' ')}`);
  printResults(wanted, p.all.map((b) => b.boundary));
  return wanted;
}

/**
 * What `init` keeps out of git. Kane recordings (.notyours/tests/, .testmuai/tests/) hold TestMu account ids (org_id,
 * user_id, project_id) and recorded logins hold typed passwords; runs/ holds raw results with Test Manager links,
 * session dirs and local screenshot paths.
 */
export const GITIGNORE_LINES = ['.notyours/secrets.json', '.notyours/profiles/', '.notyours/runs/', '.notyours/tests/',
  '.notyours/app.log', '.notyours/personas.json', '.testmuai/tests/', '.testmuai/evidence/'];

export function ensureGitignore(root: string): void {
  const lines = GITIGNORE_LINES;
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file) && !fs.existsSync(path.join(root, '.git'))) return;
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = lines.filter((l) => !current.split(/\r?\n/).includes(l));
  if (missing.length) safeAppendFile(root, file, `${current && !current.endsWith('\n') ? '\n' : ''}# notyours (secrets, browser profiles, raw runs, Kane recordings and evidence)\n${missing.join('\n')}\n`);
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

/** The real wizard: terminal prompts, real Chrome per persona, real Kane sign-ups (each one an authoring run). */
export function wizardDeps(root: string): WizardDeps {
  const stateDir = nyPaths(root).dir;
  const ask = async (question: string, def: string): Promise<string> => {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`${question} [${def}]: `)).trim();
      return answer || def;
    } finally {
      rl.close();
    }
  };
  return {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask,
    async yesNo(question, def) {
      const answer = (await ask(question, def ? 'Y/n' : 'y/N')).toLowerCase();
      return answer === 'y/n' || answer === 'y' || answer === 'yes' ? true : answer === 'n' || answer === 'no' ? false : def;
    },
    detect: detectProject,
    isUp,
    startApp,
    async balance() {
      try {
        return await kaneBalance();
      } catch {
        return undefined;
      }
    },
    async signup(identity, cfg) {
      const handle = await launchChrome(identity);
      try {
        const out = await signup(identity, runKane, { cfg, stateDir, cwd: root });
        if (out.run.status !== 'passed') {
          throw new UserError(
            `Sign-up for ${identity.id} ${out.run.status}${out.run.reason ? `: ${out.run.reason}` : ''}.`,
            'open the app in a browser and check its sign-up page; or create the accounts yourself and run `notyours init --users users.yaml`.',
          );
        }
        return out.run.creditsConsumed;
      } finally {
        await handle.close();
      }
    },
    installHooks(r) {
      const h = installHooks(r);
      return [h.settingsFile, h.launcher, h.commandFile, h.checkFile].map((f) => path.relative(r, f));
    },
  };
}

export const actions: Actions = {
  async doctor(o) {
    const root = path.resolve(o.cwd);
    let floor = 300;
    try {
      floor = readConfigIfExists(root)?.creditFloor ?? floor;
    } catch {
      /* invalid config is reported by other commands */
    }
    const checks = await runDoctor(floor, { root });
    for (const c of checks) {
      const mark = c.status === 'ok' ? pc.green('✓') : c.status === 'warn' ? pc.yellow('!') : pc.red('✗');
      log(`${mark} ${pc.bold(c.name)}  ${c.detail}`);
    }
    const failed = checks.filter((c) => c.status === 'fail').length;
    if (isJsonMode()) {
      emitJson({ ok: failed === 0, checks });
      return failed ? 1 : 0;
    }
    log();
    log(failed ? pc.red(`${failed} problem${failed === 1 ? '' : 's'} to fix.`) : pc.green('Ready.'));
    return failed ? 1 : 0;
  },

  async init(o) {
    const root = enter(o);
    // What notyours runs and where it probes is a person's decision: a coding agent's shell can't set it.
    const agent = inCodingAgent(process.env) && process.stdin.isTTY !== true && process.env[AGENT_OVERRIDE_ENV] !== '1';
    if (agent && (o.start !== undefined || o.url !== undefined || o.port !== undefined)) {
      throw new UserError(
        '--url, --start and --port change what notyours runs and where it probes, which is a person\'s decision, so a coding agent can\'t set them.',
        'run `notyours init --url ... --start ...` yourself in a terminal.',
      );
    }
    if (o.iOwnThis && o.url) await confirmOwnership([o.url, ...o.allowHost.map((h) => `http://${h}`)]);
    ensureGitignore(root); // before any secret is written
    const r = await runWizard(
      { root, url: o.url, start: o.start, port: o.port, users: o.users, yes: o.yes, hooks: o.hooks, allowHost: o.allowHost, iOwnThis: o.iOwnThis, mayStartApp: agent ? (s, p) => isApprovedFor(root, s, p) : undefined },
      wizardDeps(root),
    );
    // A person (at a terminal, or --yes in CI) approves the start command the wizard wrote. An agent's run approves nothing.
    if (!agent && r.app.start) approveStart(root, r.app.start, r.app.port);
    if (isJsonMode()) emitJson({ ok: true, ...r });
    else for (const line of summaryLines(r)) log(line);
    return 0;
  },

  async status(o) {
    const root = enter(o);
    const s = computeStatus(root);
    if (isJsonMode()) emitJson(s);
    else log(renderStatus(s));
    return 0;
  },

  async setup(target, o) {
    if (target !== 'claude') throw new UserError(`Unknown setup target "${target}".`, 'use `notyours setup claude`.');
    return actions.installHooks(o);
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
    const est = estimateAuthoring(chosen, p.identities, notyoursPaths(root).dir);
    log(`${chosen.length} boundar${chosen.length === 1 ? 'y' : 'ies'} against ${p.cfg.baseUrl}: ${estimateLine(est)}.`);
    log(pc.dim('After `notyours lock`, replays need no authoring runs: about 0–1 Kane credit and ~40–50 s per boundary on kane-cli 0.10.0.'));
    if (o.dryRun) {
      for (const b of chosen) log(`  ${pc.bold(b.id)}  ${b.kind}: ${b.owner} → ${b.viewer}  ui ${b.targets.ui.length}, api ${b.targets.api.length}${b.locked ? pc.dim('  (locked)') : ''}`);
      log(pc.dim('Dry run: nothing started.'));
      return 0;
    }
    await ensureCredits(p.cfg, est.runs);
    const started = new Date();
    const results = await withApp(root, p.cfg, () => author(p, chosen));
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
      fresh = await withApp(root, p.cfg, () => author(p, chosen));
    }
    const latest = latestResultsByBoundary(root);
    const ratchet = getRatchet(root, { reauthor: o.reauthor === true });
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
    log(`${locked} locked. Replays need no authoring runs (about 0–1 credit and ~40–50 s per boundary on kane-cli 0.10.0): notyours replay`);
    return locked === chosen.length ? 0 : 1;
  },

  async replay(ids, o) {
    const root = enter(o);
    const p = loadProject(root);
    const chosen = selectBoundaries(p.all, ids).map((b) => b.boundary); // also validates ids
    assertHostsAllowed(p.cfg, chosen, root);
    const started = new Date();
    const results = await withApp(root, p.cfg, () => replayLocked(p, ids));
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
    // Baseline for the Stop pass's surface scan, so edits made through Bash before the first stop are caught too.
    if (fs.existsSync(nyPaths(root).config)) {
      try { writeSurfaceBaseline(root, readBoundaries(root).map((b) => b.boundary)); } catch { /* optional */ }
    }
    log(`${pc.green('✓')} ${path.relative(root, r.settingsFile)}  PreToolUse guard, PostToolUse post-tool, Stop replay`);
    log(`${pc.green('✓')} ${path.relative(root, r.launcher)}  fail-closed launcher: no CLI → the hook blocks (exit 2)`);
    log(`${pc.green('✓')} ${path.relative(root, r.commandFile)}  /notyours-map`);
    log(`${pc.green('✓')} ${path.relative(root, r.checkFile)}  /notyours-check`);
    log(pc.dim('The guard keeps locked boundaries, Kane recordings, results and secrets read-only for the agent.'));
    return 0;
  },

  async release(ids, o) {
    const root = enter(o);
    assertHuman('release', process.env, process.stdin.isTTY === true, 'lifts an escalated Stop block');
    const np = notyoursPaths(root);
    const esc = readEscalated(np);
    const want = ids.length ? ids : Object.keys(esc);
    if (!want.length) { log('Nothing is escalated.'); return 0; }
    const dirty = readDirty(np);
    const attempts = readAttempts(np);
    for (const id of want) {
      for (const b of [id, ...(esc[id]?.ids ?? [])]) { delete dirty[b]; delete attempts[b]; }
      delete esc[id];
    }
    writeDirty(np, dirty);
    writeAttempts(np, attempts);
    writeEscalated(np, esc);
    if (!Object.keys(esc).length) fs.rmSync(np.escalation, { force: true });
    log(`${pc.green('✓')} released ${want.join(', ')}: the next stop won't block on them (a later edit under their surface replays them again).`);
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
    // A hook that crashes: the guard and the Stop hook fail closed (see hookFailureExit); post-tool fails open.
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
      return hookFailureExit(event);
    }
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
 * boundaries with no authoring runs, exits 2 with a leak report, escalates to the human after 3 attempts).
 */
/**
 * When a hook itself crashes. The guard and the Stop hook fail closed (exit 2: the tool call or the stop is
 * blocked, with the error on stderr); post-tool only records edits, and the Stop pass's surface scan catches them.
 */
export function hookFailureExit(event: HookEvent): number {
  if (event === 'post-tool') return 0;
  console.error(event === 'guard'
    ? 'notyours guard: blocking this tool call because the guard itself failed (fails closed).'
    : 'notyours stop: blocking the stop because the check itself failed (fails closed). Fix the error above, then stop again.');
  return 2;
}

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
