import type { Ratchet } from '../types.js';
import { MockRatchet } from './mock.js';

export { MockRatchet };

/** Entry point used by the CLI. Returns the mock until the real implementation lands. */
export function createRatchet(): Ratchet {
  return new MockRatchet();
}
