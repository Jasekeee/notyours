// Persona sessions. Many apps (the Jotter demo included) use session cookies, which a Chrome restart drops, so
// each persona logs in right after its Chrome launches: by replaying its recorded login test (0 credits), or,
// the first time only, by recording one (1 authoring run).
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { KaneCli, type KaneClient } from '../ratchet/kane.js';
import type { Config, Identity } from '../types.js';
import { ChromePool, type ChromeHandle, type LaunchOptions } from './chrome.js';
import { logCredits, runKane, type KaneRunner } from './kane.js';
import { login } from './signup.js';

export interface SessionOptions {
  cfg: Config;
  /** .notyours directory: recordings live in <stateDir>/tests. */
  stateDir: string;
  /** Project root (kane-cli writes .testmuai/ there). */
  cwd: string;
  runner?: KaneRunner;
  kane?: Pick<KaneClient, 'replay'>;
  log?: (line: string) => void;
}

export const loginTestName = (identityId: string) => `login_${identityId}`;

/** Moves kane-cli's `<name>_test.md` + `output-<name>/` from <cwd>/.testmuai/tests into `testsDir`. */
export function adoptRecording(cwd: string, name: string, testsDir: string): string {
  const src = join(cwd, '.testmuai', 'tests');
  const md = join(src, `${name}_test.md`);
  if (!existsSync(md)) throw new Error(`kane-cli did not write .testmuai/tests/${name}_test.md`);
  mkdirSync(testsDir, { recursive: true });
  const move = (from: string, to: string) => {
    rmSync(to, { recursive: true, force: true });
    try { renameSync(from, to); } catch { cpSync(from, to, { recursive: true }); rmSync(from, { recursive: true, force: true }); }
  };
  const destMd = join(testsDir, `${name}_test.md`);
  move(md, destMd);
  const out = join(src, `output-${name}`);
  if (existsSync(out)) {
    const destOut = join(testsDir, `output-${name}`);
    move(out, destOut);
    stripEnvFiles(destOut);
  }
  return destMd;
}

/** kane-cli code exports ship a .env.example; never let one ride along (the pre-push scan exempts it). */
function stripEnvFiles(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) stripEnvFiles(full);
    else if (/^\.env(\..*)?$/.test(e.name)) rmSync(full, { force: true });
  }
}

/** Log `identity` in on its freshly launched Chrome. Guests and identities without credentials are skipped. */
export async function logIn(identity: Identity, handle: ChromeHandle, opts: SessionOptions): Promise<void> {
  if (identity.role === 'guest' || !identity.email || !identity.password) return;
  const log = opts.log ?? ((l: string) => console.error(l));
  const name = loginTestName(identity.id);
  const testsDir = join(opts.stateDir, 'tests');
  const recorded = join(testsDir, `${name}_test.md`);

  if (existsSync(recorded)) {
    const kane = opts.kane ?? new KaneCli();
    const out = await kane.replay({ testPath: recorded, identity: identity.id, cdpEndpoint: handle.endpoint, cwd: opts.cwd });
    logCredits(opts.stateDir, { kind: 'replay', identity: identity.id, status: out.run.status, credits: out.run.creditsConsumed, durationS: out.run.durationS, objective: `login replay ${name}` });
    if (out.run.status === 'passed') return;
    log(`notyours: login replay for ${identity.id} ${out.run.status}${out.run.reason ? ` (${out.run.reason})` : ''}; recording a new login (1 authoring run)`);
  }

  const res = await login(identity, opts.runner ?? runKane, { cfg: opts.cfg, stateDir: opts.stateDir, cwd: opts.cwd, name });
  if (res.run.status !== 'passed') {
    throw new Error(`Could not log ${identity.id} in (${res.run.reason ?? res.run.status}). Check its email/password in .notyours/secrets.json.`);
  }
  adoptRecording(opts.cwd, name, testsDir);
}

/** A ChromePool whose Chromes come up logged in. */
export function sessionPool(opts: SessionOptions, launch: Omit<LaunchOptions, 'onLaunch'> = {}): ChromePool {
  return new ChromePool({ ...launch, onLaunch: (identity, handle) => logIn(identity, handle, opts) });
}
