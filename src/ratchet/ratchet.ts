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
  /** Max authoring runs for this project (Kane credit budget; ~30 credits each). Default 8. */
  maxAuthoringRuns?: number;
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
  private async withChromes<T>(fn: (pool: ChromePool | undefined, oracle: Oracle) => Promise<T>): Promise<T> {
    const launch = this.opts.chromes ?? (this.opts.kane === undefined && this.opts.oracle === undefined);
    if (!launch) return fn(undefined, this.opts.oracle ?? engineOracle(createEngine({ stateDir: this.paths.dir, cwd: this.paths.root })));
    const cfg = this.config();
    const pool = sessionPool({ cfg, stateDir: this.paths.dir, cwd: this.paths.root, kane: this.kane });
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
      maxAuthoringRuns: this.opts.maxAuthoringRuns ?? 8,
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
    return this.withChromes(async (pool, oracle) => {
      const out: ProbeResult[] = [];
      for (const b of bs) {
        if (pool) {
          const viewer = ids.find((i) => i.id === b.viewer);
          // A guest replays on a wiped profile: no cookies from earlier runs.
          if (b.kind === 'guest' && viewer) await wipeProfile(viewer, { stateDir: this.paths.dir, pool });
          await Promise.all([b.owner, b.viewer].map((id) => ids.find((i) => i.id === id)).filter((i): i is Identity => !!i).map((i) => pool.get(i)));
        }
        out.push(...(await replayBoundaries([b], ids, { paths: this.paths, config: this.config(), kane: this.kane, oracle })));
      }
      return out;
    });
  }
}
