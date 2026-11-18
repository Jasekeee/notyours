// Real handlers behind each CLI command.
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { getEngine, getRatchet, useReal } from './backends.js';
import { createReport } from '../report/index.js';
import { credits, headline, isLeak, parties, verdictExplanation, verdictGroup } from '../report/summary.js';
import { fmtCredits } from '../report/html.js';
import { runMap } from '../map/index.js';
import type { Boundary, Config, Identity, ProbeResult } from '../types.js';
import { runDoctor } from './doctor.js';
import { hostOf, isLocalHost } from './hosts.js';
import { isOwnedHost } from './owned.js';
import { guard, guardOutput, installHooks, postTool, type HookInput } from './hooks.js';
import { runInit } from './init.js';
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
  readDirty,
  readIdentities,
  readLatestRun,
  saveRun,
  selectBoundaries,
  writeDirty,
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

/** Dotted words in objectives that are file names, not hosts (index.html, page.tsx). */
// Only extensions that are NOT delegated TLDs (.md .py .zip .go .mov are real TLDs, so they stay hosts).
const FILE_EXT = new Set(['html', 'htm', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'yaml', 'yml', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'csv', 'txt', 'xml', 'php', 'rb']);

/**
 * Hosts a boundary will make Kane visit: absolute URLs in targets and objectives, plus (deny by default)
 * every hostname-like token or IPv4 address in the objectives, with or without a scheme or slash.
 * Email domains (alice@demo.test) are not navigation targets and are skipped.
 */
export function boundaryUrls(b: Boundary): string[] {
  // NFKC maps fullwidth letters/dots to ASCII; the other ideographic full stops are mapped by hand.
  const objectives = nfkc([b.create.objective, b.proAction?.objective ?? ''].join('\n'));
  const text = [objectives, ...b.targets.ui.map(nfkc), ...b.targets.api.map(nfkc)].join('\n');
  const urls = [...text.matchAll(/https?:\/\/[^\s'"`<>)]+/gi)].map((m) => m[0].replace(/[.,;]+$/, ''));
  // Unicode-aware: internationalised names are checked as the punycode host the browser would use.
  const hostTokens = [...objectives.matchAll(/(?<![\p{L}\p{N}_@.-])((?:[\p{L}\p{N}-]+\.)+\p{L}{2,}|\d{1,3}(?:\.\d{1,3}){3})(?![\p{L}\p{N}_-]*@)(?![\p{L}\p{N}])/gu)]
    .map((m) => toAsciiHost(m[1]!))
    .filter((h) => /^\d/.test(h) || !FILE_EXT.has(h.slice(h.lastIndexOf('.') + 1)))
    .map((h) => `http://${h}/`);
  return [...new Set([...urls, ...hostTokens])];
}

const nfkc = (s: string) => s.normalize('NFKC').replace(/[\u3002\uFF0E\uFF61]/g, '.');

/** Host as the URL parser sees it (lowercase, punycode); unparseable tokens stay as-is and fail the check. */
function toAsciiHost(token: string): string {
  try {
    return new URL(`http://${token}/`).hostname;
  } catch {
    return token.toLowerCase();
  }
}

/** A target is an absolute http(s) URL, or exactly a stored value optionally followed by a path/query. */
export const TARGET_RE = /^(?:https?:\/\/.+|\{\{\s*[A-Za-z_][\w.]*\s*\}\}(?:[/?#].*)?)$/i;

/**
 * Refuse to probe hosts we may not touch: the base URL and every URL in the boundaries must be in
 * allowHosts, and a non-local host must also be confirmed on this machine (`init --i-own-this`, stored
 * outside the repo). Fails closed on unparseable URLs and templated hosts.
 */
export function assertHostsAllowed(cfg: Config, boundaries: Boundary[], root: string): void {
  const allowed = new Set(cfg.allowHosts.map((h) => h.toLowerCase()));
  const check = (url: string, where: string) => {
    if (/^https?:\/\/[^/]*\{\{/i.test(url)) throw new UserError(`${where}: the host in ${url} is a template; only paths may use {{variables}}.`);
    let host: string;
    try {
      host = hostOf(url);
    } catch {
      throw new UserError(`${where}: can't parse URL ${url}`);
    }
    if (!allowed.has(host)) throw new UserError(`${where} points at ${host}, which is not in allowHosts (${cfg.allowHosts.join(', ')}). notyours only tests apps you own.`);
    if (!isLocalHost(host) && !isOwnedHost(root, host)) {
      throw new UserError(`${where} points at ${host}, which hasn't been confirmed on this machine. If you own it: notyours init --url ${cfg.baseUrl} --allow-host ${host} --i-own-this`);
    }
  };
  check(cfg.baseUrl, 'config.yaml baseUrl');
  for (const b of boundaries) {
    for (const t of [...b.targets.ui, ...b.targets.api].map(nfkc)) {
      if (!TARGET_RE.test(t) || /[\s'"`<>()\\]/.test(t)) {
        throw new UserError(`boundary ${b.id}: target "${t}" must be an absolute http(s) URL, or a {{stored}} value optionally followed by /path`);
      }
      if (/^https?:\/\/[^/]*\{\{/i.test(t)) throw new UserError(`boundary ${b.id}: the host in ${t} is a template; only paths may use {{variables}}.`);
      if (/^https?:/i.test(t)) {
        // Check the host the browser would actually use, parsed from the whole target string.
        let u: URL;
        try {
          u = new URL(t.replace(/\{\{[^}]*\}\}/g, 'x'));
        } catch {
          throw new UserError(`boundary ${b.id}: can't parse target ${t}`);
        }
        if (u.username || u.password) throw new UserError(`boundary ${b.id}: target ${t} contains credentials (user@host)`);
        check(`${u.protocol}//${u.host}/`, `boundary ${b.id}`);
      }
    }
    for (const u of boundaryUrls(b)) check(u, `boundary ${b.id}`);
  }
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
export async function ensureCredits(cfg: Config, authoringRuns: number, balance: () => Promise<number | undefined> = kaneBalance, real = useReal()): Promise<void> {
  if (!real) return; // mock engine: nothing is spent
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
  const engine = getEngine();
  const results: ProbeResult[] = [];
  for (const b of boundaries) {
    log(pc.dim(`→ ${b.id}: ${b.owner} creates, ${b.viewer} looks`));
    const r = await engine.runBoundary(b, p.identities, p.cfg);
    printResults([r], boundaries);
    results.push(r);
  }
  return results;
}

/** Replay locked boundaries (0 credits), optionally narrowed to ids. */
export async function replayLocked(p: Project, ids: string[]): Promise<ProbeResult[]> {
  const results = await getRatchet().replay(p.identities);
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
    let existing: Identity[] = [];
    if (fs.existsSync(nyPaths(root).secrets)) existing = readIdentities(root);
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
    const cost = useReal() ? `~${estimate} Kane credits (authoring)` : `mock engine, 0 credits (real: ~${estimate})`;
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
    const ratchet = getRatchet();
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
      await ratchet.lock(b, r);
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

  async hook(event, o) {
    // Hooks must never break the agent's session: any internal error fails open with a note on stderr.
    try {
      const root = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? o.cwd);
      const raw = await readStdin();
      const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
      const out = await runHook(event, input, root);
      if (out) process.stdout.write(`${out}\n`);
    } catch (e) {
      console.error(`notyours hook ${event}: ${(e as Error).message}`);
    }
    return 0;
  },
};

export async function runHook(event: HookEvent, input: HookInput, root: string): Promise<string | undefined> {
  if (event === 'guard') return guardOutput(guard(input, root));
  if (!fs.existsSync(nyPaths(root).config)) return undefined; // not a notyours project
  const all = readBoundaries(root);
  if (event === 'post-tool') return postTool(input, root, all.map((b) => b.boundary));

  // stop
  if (input.stop_hook_active) return undefined; // we already blocked once; let the agent stop
  const dirty = readDirty(root);
  if (!dirty.length) return undefined;
  writeDirty(root, []);
  const byId = new Map(all.map((b) => [b.boundary.id, b.boundary]));
  const locked = dirty.filter((id) => byId.get(id)?.locked);
  const unlocked = dirty.filter((id) => byId.has(id) && !byId.get(id)?.locked);
  const notes: string[] = [];
  if (unlocked.length) notes.push(`notyours: you changed code behind ${unlocked.join(', ')} (not locked). Ask the user before re-proving (~30 credits each): npx notyours run ${unlocked.join(' ')}`);
  if (!locked.length) return notes.length ? JSON.stringify({ systemMessage: notes.join('\n') }) : undefined;

  const p: Project = { root, cfg: readConfig(root), identities: readIdentities(root), all };
  assertHostsAllowed(p.cfg, locked.map((id) => byId.get(id)!), root);
  const started = new Date();
  const origLog = console.log;
  console.log = (...a: unknown[]) => console.error(...a); // stdout is reserved for the hook JSON
  let fin: Finished;
  try {
    const results = await replayLocked(p, locked);
    if (!results.length) {
      notes.push(`notyours: ${locked.join(', ')} changed but had no recorded test to replay. Lock them: npx notyours lock ${locked.join(' ')}`);
      return JSON.stringify({ systemMessage: notes.join('\n') });
    }
    fin = finish(root, 'hook stop', started, results, p);
  } finally {
    console.log = origLog;
  }
  const leaks = fin.results.filter(isLeak);
  if (leaks.length) {
    const lines = leaks.map((r) => {
      const b = byId.get(r.boundaryId);
      const hit = r.hits[0];
      return `- ${r.boundaryId}: ${verdictExplanation(r, parties(r, b))}${hit ? ` Seen at ${hit.url}: ${hit.snippet.slice(0, 160)}` : ''}${b?.surface.length ? ` Code: ${b.surface.join(', ')}` : ''}`;
    });
    return JSON.stringify({
      decision: 'block',
      reason: [`notyours: ${headline(fin.results, byId).title}. Replayed for 0 credits after your edits:`, ...lines, `Fix the access check in that code (not the test), then stop again. Report: ${fin.reportPath}`, ...notes].join('\n'),
    });
  }
  const held = fin.results.filter((r) => verdictGroup(r.verdict) === 'HELD').map((r) => r.boundaryId);
  notes.unshift(`notyours: replayed ${fin.results.length} locked boundar${fin.results.length === 1 ? 'y' : 'ies'} for 0 credits: ${held.length} held${held.length < fin.results.length ? `, ${fin.results.length - held.length} could not be judged (see ${fin.reportPath})` : ''}.`);
  return JSON.stringify({ systemMessage: notes.join('\n') });
}
