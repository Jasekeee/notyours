// replay(): re-run each locked boundary's recorded tests (0 credits), then let the engine's canary oracle judge.
import type { Boundary, Config, Engine, Identity, KaneRun, ProbeResult } from '../types.js';
import { cdpEndpoint, type KaneClient, type ReplayOutcome } from './kane.js';
import { testFile, testName, type NotyoursPaths } from './paths.js';
import { logCredits } from './store.js';

export type Light = 'RED' | 'YELLOW' | 'GREEN';

/** RED = a leak; YELLOW = the harness could not reach or judge the target; GREEN = the boundary held. */
export function classify(r: ProbeResult): Light {
  if (r.verdict === 'LEAK_VISIBLE' || r.verdict === 'LEAK_PAYLOAD') return 'RED';
  if (r.verdict === 'HELD') return 'GREEN';
  return 'YELLOW';
}

export const reauthorHint = (boundaryId: string): string =>
  `harness needs re-recording: notyours lock --reauthor ${boundaryId}`;

/**
 * Judges a boundary after its replays. The canary-token oracle lives in the engine; the frozen Engine
 * interface only has runBoundary(), so see engineOracle() for how it is reached.
 */
export interface Oracle {
  judge(b: Boundary, ids: Identity[], cfg: Config, replays: KaneRun[]): Promise<ProbeResult>;
}

/** An engine that also exposes a replay-only judge (proposed in CONTRACT_CHANGE.md, CC-1). */
type JudgingEngine = Engine & {
  judge?: (b: Boundary, ids: Identity[], cfg: Config, replays: KaneRun[]) => Promise<ProbeResult>;
};

/**
 * Uses engine.judge() when the engine has one. Otherwise falls back to runBoundary() with `locked: true`,
 * which the real engine must treat as "judge only, do not author" (see CONTRACT_CHANGE.md CC-1).
 */
export function engineOracle(engine: Engine): Oracle {
  const e = engine as JudgingEngine;
  return {
    judge: (b, ids, cfg, replays) =>
      typeof e.judge === 'function' ? e.judge(b, ids, cfg, replays) : engine.runBoundary({ ...b, locked: true }, ids, cfg),
  };
}

export interface ReplayDeps {
  paths: NotyoursPaths;
  config: Config;
  kane: KaneClient;
  oracle: Oracle;
  now?: () => Date;
}

function harnessBroken(b: Boundary, runs: KaneRun[], ts: string): ProbeResult {
  return {
    boundaryId: b.id,
    verdict: 'HARNESS_BROKEN',
    controls: { ownerSeesOwnToken: false, viewerSeesOwnToken: false },
    hits: [],
    screenshots: [],
    kaneRuns: runs,
    ts,
  };
}

/** Replays one locked boundary: owner and viewer in parallel, each in their own Chrome, then the oracle. */
export async function replayBoundary(b: Boundary, ids: Identity[], deps: ReplayDeps): Promise<ProbeResult> {
  const ts = (deps.now ?? (() => new Date()))().toISOString();
  const people = [b.owner, b.viewer].map((id) => ids.find((i) => i.id === id));
  const missing = [b.owner, b.viewer].filter((_, n) => !people[n]);
  if (missing.length) {
    return harnessBroken(b, [], ts);
  }

  const outcomes: ReplayOutcome[] = await Promise.all(
    (people as Identity[]).map((i) =>
      deps.kane.replay({
        testPath: testFile(deps.paths, b.id, i.id),
        identity: i.id,
        cdpEndpoint: cdpEndpoint(i.cdpPort),
        cwd: deps.paths.root,
      }),
    ),
  );
  for (const o of outcomes) {
    logCredits(deps.paths, {
      ts,
      kind: 'replay',
      name: testName(b.id, o.run.identity),
      identity: o.run.identity,
      status: o.run.status,
      credits: o.run.creditsConsumed,
      authorDecisions: o.authorDecisions,
    });
  }
  const runs = outcomes.map((o) => o.run);

  // The oracle decides, never Kane. A replay can "fail" exactly because the app changed (a recorded wait for
  // "Note not found" fails once the note leaks), and kane-cli 0.10.0 replays analyze->assert steps without
  // their extracted value. So always judge: the oracle visits every target itself, and its positive controls
  // turn a lost session into HARNESS_BROKEN. The replay statuses stay in kaneRuns for the report.

  const judged = await deps.oracle.judge(b, ids, deps.config, runs);
  return { ...judged, boundaryId: b.id, kaneRuns: [...judged.kaneRuns, ...runs] };
}

/** Replays boundaries one after another (each one already uses two Chromes in parallel). */
export async function replayBoundaries(bs: Boundary[], ids: Identity[], deps: ReplayDeps): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const b of bs) out.push(await replayBoundary(b, ids, deps));
  return out;
}
