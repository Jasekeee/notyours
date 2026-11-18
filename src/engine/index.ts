import { join, resolve } from 'node:path';
import type { Boundary, Config, Engine, Identity, KaneRun, ProbeResult } from '../types.js';
import { ChromePool } from './chrome.js';
import { runKane, type KaneRunner } from './kane.js';
import { MockEngine } from './mock.js';
import { probe } from './probes.js';
import { sessionPool } from './session.js';

export { MockEngine };
export { ChromePool, launchChrome, chromePath, cdpEndpoint } from './chrome.js';
export { runKane, kaneBalance, assertCreditFloor, CreditFloorError, type KaneRunner, type KaneOutcome, type KaneVars } from './kane.js';
export { createIdentities, saveIdentities, loadIdentities, importUsers, byId, DEFAULT_SPECS, type IdentitySpec } from './identities.js';
export { signup, login, UnsupportedSignupError } from './signup.js';
export { logIn, sessionPool, adoptRecording, loginTestName, type SessionOptions } from './session.js';
export { wipeProfile, recordingName } from './probes.js';
export { judge, isUrlEcho, scanText, parseTarget } from './oracle.js';

export interface EngineOptions {
  /** kane-cli runner; tests inject a fake. Default: real kane-cli (authoring runs, costs credits). */
  runner?: KaneRunner;
  /**
   * Shared Chrome pool (the ratchet passes the one its replays used). If omitted, a logged-in-on-launch
   * pool (sessionPool) is created and closed per call.
   */
  pool?: ChromePool;
  /** .notyours directory. Default: <cwd>/.notyours */
  stateDir?: string;
  /** Run id for .notyours/runs/<runId>/. Default: a timestamp per call. */
  runId?: string;
  /** Project root; kane-cli writes .testmuai/ there. Default: process.cwd(). */
  cwd?: string;
}

export class KaneEngine implements Engine {
  constructor(private readonly opts: EngineOptions = {}) {}

  /** Full probe (authoring runs). A boundary with `locked: true` is only judged: it never authors (CC-3). */
  async runBoundary(b: Boundary, ids: Identity[], cfg: Config): Promise<ProbeResult> {
    return b.locked ? this.judge(b, ids, cfg, []) : this.call(b, ids, cfg, undefined);
  }

  /**
   * Oracle only, for the ratchet (CC-3): the recorded Kane tests have just been replayed on the identities'
   * Chromes; this checks the targets and positive controls. 0 credits.
   */
  async judge(b: Boundary, ids: Identity[], cfg: Config, replays: KaneRun[]): Promise<ProbeResult> {
    return this.call(b, ids, cfg, replays);
  }

  private async call(b: Boundary, ids: Identity[], cfg: Config, replays: KaneRun[] | undefined): Promise<ProbeResult> {
    const cwd = resolve(this.opts.cwd ?? process.cwd());
    const stateDir = resolve(cwd, this.opts.stateDir ?? '.notyours');
    const runId = this.opts.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
    const runner = this.opts.runner ?? runKane;
    const pool = this.opts.pool ?? sessionPool({ cfg, stateDir, cwd, runner });
    try {
      return await probe(b, ids, cfg, {
        runner,
        pool,
        stateDir,
        runDir: join(stateDir, 'runs', runId),
        cwd,
        ...(replays ? { replays } : {}),
      });
    } finally {
      if (!this.opts.pool) await pool.closeAll();
    }
  }
}

/** The real engine: Kane personas + canary-token oracle. Use MockEngine for credit-free tests. */
export function createEngine(opts: EngineOptions = {}): KaneEngine {
  return new KaneEngine(opts);
}

