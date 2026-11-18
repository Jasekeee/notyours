import type { Ratchet } from '../types.js';
import { MockRatchet } from './mock.js';
import { RealRatchet, type RatchetOptions } from './ratchet.js';

export { MockRatchet, RealRatchet, type RatchetOptions };
export { classify, engineOracle, reauthorHint, replayBoundary, replayBoundaries, type Light, type Oracle } from './replay.js';
export { lockBoundary, planLock, resolveTemplate } from './lock.js';
export { KaneCli, parseAuthorRun, parseReplay, type KaneClient } from './kane.js';
export { notyoursPaths, testFile, testName } from './paths.js';

/**
 * Entry point used by the CLI. With a project directory it returns the real ratchet (kane-cli + .notyours/).
 * Without one it returns the in-memory mock, so the mock-wired CLI stub can never start a paid authoring run.
 */
export function createRatchet(opts?: RatchetOptions): Ratchet {
  return opts ? new RealRatchet(opts) : new MockRatchet();
}
