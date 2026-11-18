// Which engine/ratchet the CLI uses. Until the real ones are merged and verified, the CLI uses the mocks
// unless NOTYOURS_REAL=1 is set, so no command can spend Kane credits by accident.
import pc from 'picocolors';
import { MockEngine, createEngine } from '../engine/index.js';
import { MockRatchet, createRatchet } from '../ratchet/index.js';
import type { Engine, Ratchet } from '../types.js';

export function useReal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NOTYOURS_REAL === '1';
}

let noticeShown = false;
function notice(): void {
  if (noticeShown || useReal()) return;
  noticeShown = true;
  console.error(pc.yellow('! mock engine and ratchet (no Kane runs, 0 credits). Set NOTYOURS_REAL=1 for real runs.'));
}

export function getEngine(): Engine {
  notice();
  return useReal() ? createEngine() : new MockEngine();
}

// One mock ratchet per process, so lock() followed by replay() in the same command (demo) sees the lock.
let mockRatchet: MockRatchet | undefined;
export function getRatchet(): Ratchet {
  notice();
  if (useReal()) return createRatchet();
  mockRatchet ??= new MockRatchet();
  return mockRatchet;
}
