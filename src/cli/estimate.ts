// Credit estimate for `run` (and `run --dry-run`): count the authoring Kane runs a run will start, logins included,
// and print a range. No Kane, no network: it reads the boundaries and which logins are already recorded.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Boundary, Identity } from '../types.js';
import { loginRecordingDir, loginTestName } from '../engine/session.js';
import { parseTarget } from '../engine/oracle.js';

/**
 * Credits per authoring Kane run on kane-cli 0.10.0. Measured averages: 10.3 (full demo, 113.34 for 11 runs,
 * docs/E2E.md), 10.7 (3 sign-ups, 32.0) and 12.6 (one natural-app boundary, 50.2 for 4 runs; docs/STATUS.md,
 * "Onboarding"), 15.4 (quick demo, 61.69 off the balance for 4 runs). Single runs vary about 2x, hence the top.
 */
export const CREDITS_PER_RUN = { low: 10, high: 20 } as const;

/** Authoring Kane runs one boundary starts (src/engine/probes.ts): create run(s), pro actions, the viewer's visit. */
export function boundaryRuns(b: Boundary): number {
  let runs = 1; // the owner's create run
  if (b.kind !== 'guest' && !b.viewerOwn) runs += 1; // the viewer's create run (its own token is the control)
  const visits = b.targets.ui.length + b.targets.api.filter((u) => parseTarget(u).method === 'GET').length;
  if (b.kind === 'plan-gate') runs += 2 + 1; // both personas try the pro action, then the viewer's recorded visit
  else if (visits) runs += 1; // the viewer's recorded visit
  return runs;
}

/** True when this persona has a recorded login (it replays; no authoring run). */
export function hasRecordedLogin(identity: Identity, stateDir: string): boolean {
  const name = `${loginTestName(identity.id)}_test.md`;
  return [path.join(loginRecordingDir(identity), name), path.join(stateDir, 'tests', name)].some((f) => existsSync(f));
}

export interface AuthoringEstimate {
  /** Personas whose login will be recorded (1 authoring run each). */
  logins: string[];
  boundaries: number;
  boundaryRuns: number;
  runs: number;
  low: number;
  high: number;
}

export function estimateAuthoring(boundaries: Boundary[], identities: Identity[], stateDir: string): AuthoringEstimate {
  const byId = new Map(identities.map((i) => [i.id, i]));
  const used = new Set(boundaries.flatMap((b) => [b.owner, b.viewer]));
  const logins = [...used].filter((id) => {
    const i = byId.get(id);
    return !!i && i.role !== 'guest' && !!i.email && !hasRecordedLogin(i, stateDir);
  }).sort();
  const bRuns = boundaries.reduce((n, b) => n + boundaryRuns(b), 0);
  const runs = bRuns + logins.length;
  return { logins, boundaries: boundaries.length, boundaryRuns: bRuns, runs, low: runs * CREDITS_PER_RUN.low, high: runs * CREDITS_PER_RUN.high };
}

export function estimateLine(e: AuthoringEstimate): string {
  const parts = [`${e.boundaryRuns} for ${e.boundaries} boundar${e.boundaries === 1 ? 'y' : 'ies'}`];
  if (e.logins.length) parts.unshift(`${e.logins.length} login${e.logins.length === 1 ? '' : 's'} to record (${e.logins.join(', ')})`);
  return `about ${e.low}–${e.high} Kane credits: ${e.runs} authoring run${e.runs === 1 ? '' : 's'} (${parts.join(' + ')}), ` +
    `${CREDITS_PER_RUN.low}–${CREDITS_PER_RUN.high} each on kane-cli 0.10.0`;
}
