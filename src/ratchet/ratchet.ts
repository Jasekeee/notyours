import { createEngine } from '../engine/index.js';
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
}

export class RealRatchet implements Ratchet {
  readonly paths: NotyoursPaths;
  private readonly kane: KaneClient;
  private readonly oracle: Oracle;

  constructor(private readonly opts: RatchetOptions) {
    this.paths = notyoursPaths(opts.projectDir);
    this.kane = opts.kane ?? new KaneCli();
    this.oracle = opts.oracle ?? engineOracle(createEngine());
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
    await lockBoundary({ ...stored, boundary: { ...stored.boundary, ...b, locked: stored.boundary.locked } }, result, {
      paths: this.paths,
      config: this.config(),
      identities: this.opts.identities ?? loadIdentities(this.paths),
      kane: this.kane,
      maxAuthoringRuns: this.opts.maxAuthoringRuns ?? 8,
      reauthor: this.opts.reauthor ?? false,
      ...(this.opts.log ? { log: this.opts.log } : {}),
    });
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
    return replayBoundaries(bs, ids, { paths: this.paths, config: this.config(), kane: this.kane, oracle: this.oracle });
  }
}
