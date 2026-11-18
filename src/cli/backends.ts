// The engine and ratchet the CLI uses: always the real ones (Kane personas + canary-token oracle).
// Authoring spends Kane credits (ensureCredits guards it); replays are free. Tests inject their own backends
// or use MockEngine / MockRatchet directly, so `npm test` never starts a Kane run.
import { createEngine, type ChromePool } from '../engine/index.js';
import { RealRatchet } from '../ratchet/index.js';
import type { Engine } from '../types.js';

export function getEngine(root: string, pool?: ChromePool): Engine {
  return createEngine({ cwd: root, ...(pool ? { pool } : {}) });
}

export function getRatchet(root: string): RealRatchet {
  return new RealRatchet({ projectDir: root, log: (l) => console.error(l) });
}
