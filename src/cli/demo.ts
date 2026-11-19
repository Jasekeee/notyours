// `notyours demo`: copy the packaged demo app to a work dir, start it on :3077, probe every demo boundary
// (replay if locked, else author), write and open the report, print the elapsed time.
// Works from `npx github:Jasekeee/notyours demo`: no repo checkout, no Claude key. Needs Chrome + an authenticated kane-cli.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import type { ProbeResult } from '../types.js';
import { getRatchet } from './backends.js';
import { CREDITS_PER_AUTHORING, assertHostsAllowed, author, ensureCredits, finish, replayLocked } from './commands.js';
import { DEMO_PORT, kaneReplaysCost } from './doctor.js';
import { runInit } from './init.js';
import type { DemoOpts } from './program.js';
import { isPortFree, kaneVersion, openFile, waitForHttp } from './system.js';
import { UserError, nyPaths, readBoundaries, readConfig, readIdentities } from './workspace.js';

export const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`;

/** `--quick`: only B1 (Bob opens Alice's note), the clearest real leak. */
export const QUICK_BOUNDARY = 'b1-notes-cross-user';

/**
 * What a fresh demo costs, from the measured E2E runs on kane-cli 0.10.0 (docs/E2E.md): each persona's first
 * login is recorded (1 authoring run each), then every boundary is authored. Recordings stay local
 * (never committed: they hold account ids), so `--dir <same dir>` is what makes a rerun cheap.
 */
export function demoEstimate(quick: boolean, kaneVersion?: string): string {
  // Measured: kane-cli 0.10.0 (docs/E2E.md) and 0.10.6 (docs/KANE_COMPAT.md; full is extrapolated).
  const slow = kaneReplaysCost(kaneVersion);
  // 0.10.0 measured on the account balance (docs/SUBMISSION.md, the audit): quick 61 (48.8 logged), full 163.
  const [qt, qc, ft, fc] = slow ? ['~10 min', '~65', '~25 min', '~170'] : ['~4 min', '~50–60', '~11 min', '~120–165'];
  const lines = [
    `${quick ? pc.bold('→ quick') : '  quick'}  (B1 only, --quick): ${qt}, ${qc} Kane credits (4 authoring runs: 2 logins + B1)`,
    `${quick ? '  full ' : pc.bold('→ full ')}  (B1–B4):            ${ft}, ${fc} Kane credits (12 authoring runs)`,
    ...(kaneVersion ? [pc.dim(`  (estimates for kane-cli ${kaneVersion}${slow ? '; replays on this version also cost a few credits' : ''})`)] : []),
    pc.dim('  Run it again from the same folder to reuse ./notyours-demo (recorded logins replay). No credits at all:'),
    pc.dim(`  ${SAMPLE_REPORT_URL}`),
  ];
  return lines.join('\n');
}
const USERS_FILES = ['users.yaml', 'users.yml', 'users.json'];
/** The redacted sample result, for judges with no Kane credits. */
export const SAMPLE_REPORT_URL = 'https://raw.githubusercontent.com/Jasekeee/notyours/main/docs/sample-report/report.html';
/** Default work folder: in the current folder (not the OS temp dir, which gets cleaned), reused on the next run. */
export const DEFAULT_DEMO_DIR = 'notyours-demo';
/** Never copied from the package into the work dir: deps, and run state under .notyours/ or .testmuai/. */
/**
 * Repo-only parts of demo/ that a demo copy (`notyours demo`, and loop dirs made with `demo --dir`) must not get:
 * Jotter's own tests assert the seeded bugs on purpose, so in a copy they would fight an agent that fixes them;
 * data/ is a locally built database that would make the copy skip its fresh seed; KANE_RUNS.md is agent B's dev log.
 */
export const DEMO_REPO_ONLY = ['test', 'vitest.config.js', 'data', 'KANE_RUNS.md'];

/** copyFilter plus the repo-only top-level entries of the demo folder `src`. */
export function demoCopyFilter(src: string): (p: string) => boolean {
  return (p) => {
    const rel = path.relative(src, p).split(path.sep);
    if (rel.length >= 1 && DEMO_REPO_ONLY.includes(rel[0]!) && !rel[0]!.startsWith('..')) return false;
    return copyFilter(p);
  };
}

export function copyFilter(p: string): boolean {
  const parts = p.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? '';
  if (base === 'node_modules' || base === '.DS_Store') return false;
  const parent = parts[parts.length - 2];
  if (parent === '.notyours' && ['runs', 'profiles', 'secrets.json'].includes(base)) return false;
  if (parent === '.testmuai' && base === 'evidence') return false;
  return true;
}

/** The packaged demo/: next to dist/ when installed, or the repo root's demo/ in development.
 *  NOTYOURS_DEMO_DIR overrides it (for working on the demo app itself). */
export function packagedDemoDir(from = path.dirname(fileURLToPath(import.meta.url)), env = process.env): string | undefined {
  if (env.NOTYOURS_DEMO_DIR) return path.resolve(env.NOTYOURS_DEMO_DIR);
  // Bundled chunks live in dist/ (demo/ is ..); sources in src/cli/ (demo/ is ../..).
  for (const up of ['..', '../..']) {
    const d = path.resolve(from, up, 'demo');
    if (fs.existsSync(d) && fs.readdirSync(d).some((f) => f !== '.gitkeep')) return d;
  }
  return undefined;
}

/** Directory holding notyours' own dependencies (express, sql.js, ...), so the copied demo can import them. */
function depsDir(): string | undefined {
  try {
    const p = createRequire(import.meta.url).resolve('express/package.json');
    return p.slice(0, p.lastIndexOf(`${path.sep}node_modules${path.sep}`) + `${path.sep}node_modules`.length);
  } catch {
    return undefined;
  }
}

/** How to start the demo: package.json "start" script, else the first server file found. */
export function demoStartCommand(dir: string): { cmd: string; args: string[] } {
  const pkgFile = path.join(dir, 'package.json');
  if (fs.existsSync(pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string>; main?: string };
    if (pkg.scripts?.start) return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', '--silent', 'start'] };
    if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return { cmd: process.execPath, args: [pkg.main] };
  }
  for (const f of ['server.js', 'server.mjs', 'index.js', 'index.mjs', 'app.js']) {
    if (fs.existsSync(path.join(dir, f))) return { cmd: process.execPath, args: [f] };
  }
  throw new UserError(`Don't know how to start the demo in ${dir}: add a "start" script or server.js`);
}

function stop(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function tail(file: string, n = 15): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n');
}

export async function runDemo(o: DemoOpts): Promise<number> {
  const t0 = Date.now();
  const src = packagedDemoDir();
  if (!src) throw new UserError('The demo app is missing from this notyours package (demo/ not found).');
  if (!(await isPortFree(DEMO_PORT))) throw new UserError(`Port ${DEMO_PORT} is in use; the demo app needs it. Find it: lsof -i :${DEMO_PORT}`);

  console.log(demoEstimate(o.quick === true, await kaneVersion()));
  const work = path.resolve(o.dir ?? DEFAULT_DEMO_DIR);
  const reused = fs.existsSync(path.join(work, '.notyours', 'secrets.json'));
  const rel = path.relative(process.cwd(), work); // before the chdir below
  const shownWork = rel.startsWith('..') || path.isAbsolute(rel) ? work : `./${rel || '.'}`;
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(src, work, { recursive: true, force: false, errorOnExist: false, filter: demoCopyFilter(src) });
  const deps = depsDir();
  if (deps && !fs.existsSync(path.join(work, 'node_modules'))) fs.symlinkSync(deps, path.join(work, 'node_modules'), 'junction');
  process.chdir(work); // Kane writes .testmuai/ (incl. evidence packs) into the working directory
  console.log(`${pc.bold('notyours demo')}  ${shownWork}${reused ? pc.dim('  (reusing it: recorded logins replay)') : ''}`);
  console.log(pc.dim(`  The report will be written to ${shownWork}/.notyours/runs/<time>/report.html`));

  // Identities: kept from a previous run in --dir, else created from the demo's users file.
  const p = nyPaths(work);
  if (!fs.existsSync(p.secrets)) {
    const users = USERS_FILES.map((f) => path.join(p.dir, f)).find((f) => fs.existsSync(f));
    let url = DEMO_URL;
    if (fs.existsSync(p.config)) url = readConfig(work).baseUrl;
    runInit(work, { url, users });
  }
  const cfg = readConfig(work);
  const identities = readIdentities(work);
  const all = readBoundaries(work);
  if (!all.length) throw new UserError(`The demo has no boundaries in ${path.join(work, '.notyours/boundaries')}`);
  const boundaries = all.map((b) => b.boundary).filter((b) => !o.quick || b.id === QUICK_BOUNDARY);
  if (!boundaries.length) throw new UserError(`--quick needs boundary ${QUICK_BOUNDARY} in the demo`);
  assertHostsAllowed(cfg, boundaries, work);

  const logFile = path.join(work, 'demo-server.log');
  const out = fs.openSync(logFile, 'a');
  const start = demoStartCommand(work);
  const server = spawn(start.cmd, start.args, {
    cwd: work,
    env: { ...process.env, PORT: String(DEMO_PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: ['ignore', out, out],
    detached: process.platform !== 'win32',
  });
  const cleanup = () => stop(server);
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.once('exit', cleanup);

  try {
    console.log(pc.dim(`Starting the demo app on :${DEMO_PORT}…`));
    if (!(await waitForHttp(`${DEMO_URL}/`, 30_000))) {
      throw new UserError(`The demo app did not answer on :${DEMO_PORT} within 30s. Server log:\n${tail(logFile)}`);
    }

    const project = { root: work, cfg, identities, all };
    const locked = boundaries.filter((b) => b.locked);
    const fresh = boundaries.filter((b) => !b.locked);
    const started = new Date();
    const results: ProbeResult[] = [];
    if (locked.length) {
      console.log(`Replaying ${locked.length} recorded boundar${locked.length === 1 ? 'y' : 'ies'} (0 credits)…`);
      results.push(...(await replayLocked(project, locked.map((b) => b.id))));
    }
    if (fresh.length) {
      console.log(`Authoring ${fresh.length} boundar${fresh.length === 1 ? 'y' : 'ies'} with Kane (~${fresh.length * CREDITS_PER_AUTHORING} credits)…`);
      await ensureCredits(cfg, fresh.length);
      const authored = await author(project, fresh);
      results.push(...authored);
      // Lock what was proven so the next run (with --dir) replays it for 0 credits.
      const ratchet = getRatchet(work);
      for (const r of authored) {
        const b = fresh.find((x) => x.id === r.boundaryId);
        if (!b || r.verdict !== 'HELD') continue; // only proven HELD boundaries are locked
        try {
          await ratchet.lock(b, r);
        } catch (e) {
          console.log(pc.dim(`  not locked: ${b.id}: ${(e as Error).message.replace(/^notyours: /, '')}`));
        }
      }
    }
    const fin = finish(work, 'demo', started, results, project);
    if (o.open) openFile(fin.reportPath);
    const s = (Date.now() - t0) / 1000;
    console.log(pc.bold(`Done in ${s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`}.`));
    if (fresh.length) console.log(pc.dim(`Run the same command again here to reuse ${work} (recorded logins replay).`));
    return 0; // the demo app leaks on purpose: leaks are the expected outcome, not a failure
  } finally {
    cleanup();
    fs.closeSync(out);
  }
}
