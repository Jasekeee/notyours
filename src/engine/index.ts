import { join, resolve } from 'node:path';
import type { Boundary, Config, Engine, Identity, ProbeResult } from '../types.js';
import { ChromePool } from './chrome.js';
import { runKane, type KaneRunner } from './kane.js';
import { MockEngine } from './mock.js';
import { probe } from './probes.js';

export { MockEngine };
export { ChromePool, launchChrome, chromePath } from './chrome.js';
export { runKane, kaneBalance, assertCreditFloor, CreditFloorError, type KaneRunner, type KaneOutcome, type KaneVars } from './kane.js';
export { createIdentities, saveIdentities, loadIdentities, importUsers, byId, DEFAULT_SPECS, type IdentitySpec } from './identities.js';
export { signup, login, UnsupportedSignupError } from './signup.js';
export { judge, isUrlEcho, scanText } from './oracle.js';

export interface EngineOptions {
  /** kane-cli runner; tests inject a fake. Default: real kane-cli (authoring runs, costs credits). */
  runner?: KaneRunner;
  /** Shared Chrome pool (e.g. reuse the Chromes signup used). If omitted, one is created and closed per boundary. */
  pool?: ChromePool;
  /** .notyours directory. Default: ./.notyours */
  stateDir?: string;
  /** Run id for .notyours/runs/<runId>/. Default: a timestamp per runBoundary call. */
  runId?: string;
  /** cwd for kane-cli (it writes .testmuai/ there). */
  cwd?: string;
}

export class KaneEngine implements Engine {
  constructor(private readonly opts: EngineOptions = {}) {}

  async runBoundary(b: Boundary, ids: Identity[], cfg: Config): Promise<ProbeResult> {
    const stateDir = resolve(this.opts.stateDir ?? '.notyours');
    const runId = this.opts.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
    const pool = this.opts.pool ?? new ChromePool();
    try {
      return await probe(b, ids, cfg, {
        runner: this.opts.runner ?? runKane,
        pool,
        stateDir,
        runDir: join(stateDir, 'runs', runId),
        ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      });
    } finally {
      if (!this.opts.pool) await pool.closeAll();
    }
  }
}

/** The real engine: Kane personas + canary-token oracle. Use MockEngine for credit-free tests. */
export function createEngine(opts: EngineOptions = {}): Engine {
  return new KaneEngine(opts);
}
