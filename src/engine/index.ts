import type { Engine } from '../types.js';
import { MockEngine } from './mock.js';

export { MockEngine };

/** Entry point used by the CLI. Returns the mock until the real implementation lands. */
export function createEngine(): Engine {
  return new MockEngine();
}
