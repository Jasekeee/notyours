// lock(): turn a HELD probe into two recorded, replayable (0-credit) Kane tests, one per identity.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Boundary, Config, Identity, KaneRun, ProbeResult } from '../types.js';
import { safeObjectiveUrl } from '../engine/probes.js';
import { cdpEndpoint, type KaneClient } from './kane.js';
import { testFile, testName, testOutputDir, type NotyoursPaths } from './paths.js';
import { logCredits, markLocked, readCreditLog, type StoredBoundary } from './store.js';

export interface LockDeps {
  paths: NotyoursPaths;
  config: Config;
  identities: Identity[];
  kane: KaneClient;
  /** Hard cap on authoring runs across the project (counted from the credits log). */
  maxAuthoringRuns: number;
  /** Re-record even when tests already exist (`notyours lock --reauthor <id>`). */
  reauthor?: boolean;
  log?: (line: string) => void;
  /** Bring up (logged-in) Chromes for these identities before authoring. */
  prepare?: (identities: Identity[]) => Promise<void>;
}

/**
 * The probe's recordings are only worth adopting if its runs passed. Exception: the free user's pro-action
 * attempt in a plan-gate, which is expected to be refused (and is not a recording).
 */
export function probeRunsPassed(b: Boundary, result: ProbeResult): boolean {
  const relevant = result.kaneRuns.filter((r) => (r.identity === b.owner || r.identity === b.viewer)
    && !(b.kind === 'plan-gate' && r.identity === b.viewer && b.proAction && r.objective === b.proAction.objective));
  return relevant.length > 0 && relevant.every((r) => r.status === 'passed');
}

/** Adopts `<boundary>_<owner>` and `<boundary>_<viewer>` from .testmuai/tests when both exist. */
export function adoptProbeRecordings(paths: NotyoursPaths, b: Boundary): boolean {
  const names = [testName(b.id, b.owner), testName(b.id, b.viewer)];
  if (!names.every((n) => existsSync(path.join(paths.kaneTests, `${n}_test.md`)))) return false;
  for (const n of names) adoptTest(paths, n);
  return true;
}

export interface LockPlan {
  identity: Identity;
  name: string;
  objective: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Replace {{name}} with values; throws on any name without a value (a half-resolved URL is never recorded). */
export function resolveTemplate(s: string, values: Record<string, unknown>): string {
  const missing: string[] = [];
  const out = s.replace(PLACEHOLDER, (_m, name: string) => {
    const v = values[name];
    if (v === undefined || v === null || v === '') {
      missing.push(name);
      return '';
    }
    return String(v);
  });
  if (missing.length) throw new Error(`notyours: cannot lock, no stored value for {{${missing.join('}}, {{')}}}`);
  return out;
}

/** Values stored by the probe's Kane runs (owner's create run first, so its values win). */
export function storedValues(b: Boundary, result: ProbeResult): Record<string, unknown> {
  const runs: KaneRun[] = [...result.kaneRuns.filter((r) => r.identity !== b.owner), ...result.kaneRuns.filter((r) => r.identity === b.owner)];
  return Object.assign({}, ...runs.map((r) => r.finalState));
}

export function assertLockable(b: Boundary, result: ProbeResult): void {
  if (result.boundaryId !== b.id) throw new Error(`notyours: result is for ${result.boundaryId}, not ${b.id}`);
  if (result.verdict !== 'HELD') throw new Error(`notyours: only HELD boundaries are locked (${b.id} is ${result.verdict})`);
  if (!result.controls.ownerSeesOwnToken || !result.controls.viewerSeesOwnToken) {
    throw new Error(`notyours: ${b.id} HELD without both positive controls; not locking an unproven harness`);
  }
}

/** `"POST http://x/api"` (the demo's convention for non-GET API targets) or a plain URL (GET). */
export function targetStep(target: string, first: boolean): string {
  const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i.exec(target.trim());
  const method = (m?.[1] ?? 'GET').toUpperCase();
  // Written into a recorded Kane objective: exactly one http(s) URL, normalised (no smuggled instructions).
  const url = safeObjectiveUrl(m?.[2] ?? target.trim());
  if (method === 'GET') return `${first ? 'Go' : 'then go'} to ${url}`;
  return `${first ? 'Call' : 'then call'} ${method} ${url}`;
}

/**
 * The two authoring runs a lock needs. Owner: the boundary's own create objective (its positive control:
 * the owner reaches data holding their token; works for every kind, incl. plan-gate). Viewer: the targets,
 * or the pro action for a plan-gate. Every {{name}} is resolved to the probe's stored values, so replays
 * go to fixed URLs (replay ignores changed variables).
 */
export function planLock(b: Boundary, result: ProbeResult, identities: Identity[]): LockPlan[] {
  const owner = identities.find((i) => i.id === b.owner);
  const viewer = identities.find((i) => i.id === b.viewer);
  if (!owner || !viewer) throw new Error(`notyours: cannot lock ${b.id}, identity ${!owner ? b.owner : b.viewer} not configured`);
  const values = storedValues(b, result);
  const targets = [...b.targets.ui, ...b.targets.api].map((t) => resolveTemplate(t, values));
  if (!targets.length) throw new Error(`notyours: cannot lock ${b.id}, it has no targets`);

  const ownerObjective = resolveTemplate(b.create.objective, { ...values, token: owner.token });
  // The viewer's recording is a plain visit of the GET targets, for every kind. Non-GET api targets
  // ("POST <url>") are called by the oracle itself; and a plan-gate's pro action is not recorded, because a
  // correctly refused attempt (paywall) would replay as "failed" and read as a broken harness.
  const gets = targets.filter((t) => !/^(POST|PUT|PATCH|DELETE)\s/i.test(t.trim()));
  if (!gets.length) throw new Error(`notyours: cannot lock ${b.id}, it has no GET target for the viewer to record`);
  const viewerObjective = gets.map((t, n) => targetStep(t, n === 0)).join(', ');
  return [
    { identity: owner, name: testName(b.id, owner.id), objective: ownerObjective },
    { identity: viewer, name: testName(b.id, viewer.id), objective: viewerObjective },
  ];
}

function moveInto(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  try {
    renameSync(src, dest);
  } catch {
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

/** Moves `<name>_test.md` and its recordings (`output-<name>/`) from .testmuai/tests into .notyours/tests. */
export function adoptTest(paths: NotyoursPaths, name: string): string {
  const srcMd = path.join(paths.kaneTests, `${name}_test.md`);
  if (!existsSync(srcMd)) throw new Error(`notyours: kane-cli did not write ${path.relative(paths.root, srcMd)}`);
  mkdirSync(paths.tests, { recursive: true });
  const destMd = path.join(paths.tests, `${name}_test.md`);
  moveInto(srcMd, destMd);
  // Without the recordings a replay would re-author from scratch, which costs credits.
  const srcOut = testOutputDir(paths.kaneTests, name);
  if (existsSync(srcOut)) {
    const destOut = testOutputDir(paths.tests, name);
    moveInto(srcOut, destOut);
    removeEnvFiles(destOut);
  }
  return destMd;
}

/**
 * kane-cli's code export ships a `.env.example` with LT_USERNAME/LT_ACCESS_KEY slots (empty in 0.10.0).
 * The pre-push secret scan exempts `.env.example`, so never let one ride along into .notyours/tests.
 */
function removeEnvFiles(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) removeEnvFiles(full);
    else if (/^\.env(\..*)?$/.test(e.name)) rmSync(full, { force: true });
  }
}

export function hasLockedTests(paths: NotyoursPaths, b: Boundary): boolean {
  return [b.owner, b.viewer].every((id) => existsSync(testFile(paths, b.id, id)));
}

export async function lockBoundary(stored: StoredBoundary, result: ProbeResult, deps: LockDeps): Promise<void> {
  const b = stored.boundary;
  const log = deps.log ?? (() => {});
  assertLockable(b, result);

  if (!deps.reauthor && hasLockedTests(deps.paths, b)) {
    if (!b.locked) markLocked(stored);
    log(`${b.id}: already recorded, no authoring needed`);
    return;
  }

  // The probe that produced this HELD result already recorded both runs under the same names
  // (<boundary>_<identity> in .testmuai/tests): adopt them instead of paying for two new recordings.
  if (!deps.reauthor && probeRunsPassed(b, result) && adoptProbeRecordings(deps.paths, b)) {
    markLocked(stored);
    log(`${b.id}: adopted the probe's recordings, 0 authoring runs`);
    return;
  }

  const plans = planLock(b, result, deps.identities);
  if (deps.prepare) await deps.prepare(plans.map((p) => p.identity));

  const used = readCreditLog(deps.paths).filter((e) => e.kind === 'author').length;
  if (used + plans.length > deps.maxAuthoringRuns) {
    throw new Error(`notyours: authoring budget reached (${used}/${deps.maxAuthoringRuns} runs used, ${b.id} needs ${plans.length})`);
  }
  const balance = await deps.kane.balance(deps.paths.root);
  if (balance === undefined) throw new Error('notyours: could not read the Kane credit balance; not authoring');
  if (balance < deps.config.creditFloor) {
    throw new Error(`notyours: Kane balance ${balance.toFixed(0)} is below creditFloor ${deps.config.creditFloor}; not authoring`);
  }

  // Sequential on purpose: if the owner's recording fails, the viewer's credits are not spent.
  for (const plan of plans) {
    const run = await deps.kane.author({
      objective: plan.objective,
      identity: plan.identity.id,
      name: plan.name,
      cdpEndpoint: cdpEndpoint(plan.identity.cdpPort),
      cwd: deps.paths.root,
    });
    logCredits(deps.paths, {
      ts: new Date().toISOString(),
      kind: 'author',
      name: plan.name,
      identity: plan.identity.id,
      status: run.status,
      credits: run.creditsConsumed,
    });
    log(`${plan.name}: ${run.status}, ${run.creditsConsumed.toFixed(2)} credits`);
    if (run.status !== 'passed') {
      throw new Error(`notyours: recording ${plan.name} ${run.status}${run.reason ? ` (${run.reason})` : ''}; ${b.id} not locked`);
    }
    adoptTest(deps.paths, plan.name);
  }
  markLocked(stored);
}
