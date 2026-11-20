import { assertHostsAllowed } from '../cli/host-gate.js';
import { guestViewerProblem } from '../engine/identities.js';
import { createEngine, sessionPool, wipeProfile, type ChromePool } from '../engine/index.js';
import type { Boundary, Config, Identity, ProbeResult, Ratchet } from '../types.js';
import { KaneCli, type KaneClient } from './kane.js';
import { lockBoundary } from './lock.js';
import { notyoursPaths, type NotyoursPaths } from './paths.js';
import { engineOracle, replayBoundaries, type Oracle } from './replay.js';
import { loadBoundaries, loadConfig, loadIdentities, type StoredBoundary } from './store.js';

export interface RatchetOptions {
  projectDir: string;
  /** Defaults to .notyours/config.yaml. */
  config?: Config;
  /** Defaults to .notyours/secrets.json. Used by lock() (replay() takes them as an argument). */
  identities?: Identity[];
  kane?: KaneClient;
  /** Defaults to engineOracle(createEngine()). */
  oracle?: Oracle;
  reauthor?: boolean;
  log?: (line: string) => void;
  /**
   * Launch one logged-in Chrome per identity for lock/replay (kane-cli and the oracle connect over CDP).
   * Default: only with the real kane-cli and engine oracle (an injected KaneClient or Oracle means a test).
   */
  chromes?: boolean;
}

export class RealRatchet implements Ratchet {
  readonly paths: NotyoursPaths;
  private readonly kane: KaneClient;

  constructor(private readonly opts: RatchetOptions) {
    this.paths = notyoursPaths(opts.projectDir);
    this.kane = opts.kane ?? new KaneCli();
  }

  /**
   * Runs `fn` with one logged-in Chrome per identity (kane-cli and the oracle both connect over CDP),
   * then closes them. The engine oracle shares the same pool. Injected oracles (tests) skip Chrome.
   */
  private async withChromes<T>(fn: (pool: ChromePool | undefined, oracle: Oracle) => Promise<T>, ownPages?: Record<string, string[]>): Promise<T> {
    const launch = this.opts.chromes ?? (this.opts.kane === undefined && this.opts.oracle === undefined);
    if (!launch) return fn(undefined, this.opts.oracle ?? engineOracle(createEngine({ stateDir: this.paths.dir, cwd: this.paths.root })));
    const cfg = this.config();
    const pool = sessionPool({ cfg, stateDir: this.paths.dir, cwd: this.paths.root, kane: this.kane, rerecordOnFailure: false, ...(ownPages ? { ownPages } : {}) });
    const oracle = engineOracle(createEngine({ pool, stateDir: this.paths.dir, cwd: this.paths.root }));
    try {
      return await fn(pool, oracle);
    } finally {
      await pool.closeAll();
    }
  }

  private config(): Config {
    return this.opts.config ?? loadConfig(this.paths);
  }

  private stored(id: string): StoredBoundary {
    const s = loadBoundaries(this.paths).find((x) => x.boundary.id === id);
    if (!s) throw new Error(`notyours: boundary ${id} not found in .notyours/boundaries`);
    return s;
  }

  async lock(b: Boundary, result: ProbeResult): Promise<void> {
    const stored = this.stored(b.id);
    await this.withChromes((pool) => lockBoundary({ ...stored, boundary: { ...stored.boundary, ...b, locked: stored.boundary.locked } }, result, {
      paths: this.paths,
      config: this.config(),
      identities: this.opts.identities ?? loadIdentities(this.paths),
      kane: this.kane,
      reauthor: this.opts.reauthor ?? false,
      ...(this.opts.log ? { log: this.opts.log } : {}),
      ...(pool ? { prepare: async (people: Identity[]) => { await Promise.all(people.map((i) => pool.get(i))); } } : {}),
    }));
  }

  /** Replays every locked boundary. */
  async replay(ids: Identity[]): Promise<ProbeResult[]> {
    return this.replayIds(ids, undefined);
  }

  /** Replays only the given locked boundaries (the Stop hook passes the dirty ones). */
  async replayIds(ids: Identity[], boundaryIds: string[] | undefined): Promise<ProbeResult[]> {
    const want = boundaryIds ? new Set(boundaryIds) : undefined;
    const bs = loadBoundaries(this.paths)
      .map((s) => s.boundary)
      .filter((b) => b.locked && (!want || want.has(b.id)));
    if (!bs.length) return [];
    // Host gate on every replay path (CLI replay, demo, the Stop hook in any app folder): allowHosts plus
    // the human's out-of-repo ownership record. Throws (fails closed) before any Chrome or Kane work.
    assertHostsAllowed(this.config(), bs, this.paths.root);
    return this.withChromes(async (pool, oracle) => {
      const out: ProbeResult[] = new Array(bs.length);
      // Up to 2 boundaries at once, only when they share no persona (two Kane replays can't drive one Chrome).
      const running: { who: Set<string>; done: Promise<void> }[] = [];
      for (const [n, b] of bs.entries()) {
        const who = new Set([b.owner, b.viewer]);
        while (running.length >= 2 || running.some((r) => [...who].some((w) => r.who.has(w)))) await Promise.race(running.map((r) => r.done));
        const slot = { who, done: Promise.resolve() };
        slot.done = this.replayOne(b, ids, pool, oracle).then((r) => { out[n] = r; }).finally(() => { running.splice(running.indexOf(slot), 1); });
        running.push(slot);
      }
      await Promise.all(running.map((r) => r.done));
      return out;
    }, ownPagesFor(bs));
  }

  private async replayOne(b: Boundary, ids: Identity[], pool: ChromePool | undefined, oracle: Oracle): Promise<ProbeResult> {
    try {
      // Never log a credentialed "guest" in and call the result a guest check (audit P1-17): HARNESS, not HELD.
      const guest = guestViewerProblem(b, ids);
      if (guest) throw new Error(guest);
      if (pool) {
        const viewer = ids.find((i) => i.id === b.viewer);
        // A guest replays on a wiped profile: no cookies from earlier runs.
        if (b.kind === 'guest' && viewer) await wipeProfile(viewer, { stateDir: this.paths.dir, pool });
        await Promise.all([b.owner, b.viewer].map((id) => ids.find((i) => i.id === id)).filter((i): i is Identity => !!i).map((i) => pool.get(i)));
      }
      const [r] = await replayBoundaries([b], ids, { paths: this.paths, config: this.config(), kane: this.kane, oracle });
      return r!;
    } catch (e) {
      // One boundary's failure must not discard the others' verdicts (loop-run-1 lost a RED this way).
      this.opts.log?.(`notyours: ${b.id} could not be replayed: ${(e as Error).message}`);
      return { boundaryId: b.id, verdict: 'HARNESS_BROKEN', controls: { ownerSeesOwnToken: false, viewerSeesOwnToken: false }, hits: [], screenshots: [], kaneRuns: [], ts: new Date().toISOString() };
    }
  }
}

/**
 * Pages where each persona sees its own token, from the boundaries' literal URLs: the viewer's `viewerOwn` pages, and
 * the owner's targets (the owner can see its own record there). The session pool uses them to skip the login replay
 * of a persona that is still signed in.
 */
export function ownPagesFor(bs: Boundary[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (id: string, urls: string[]) => {
    const lit = urls.filter((u) => /^https?:\/\//.test(u) && !u.includes('{{'));
    if (lit.length) out[id] = [...new Set([...(out[id] ?? []), ...lit])];
  };
  for (const b of bs) {
    if (b.kind !== 'guest' && b.viewerOwn) add(b.viewer, b.viewerOwn.ui);
    add(b.owner, b.targets.ui);
  }
  return out;
}
