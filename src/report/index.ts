import type { Report } from '../types.js';
import { MockReport } from './mock.js';

export { MockReport };

/** Entry point used by the CLI. Returns the mock until the real implementation lands. */
export function createReport(): Report {
  return new MockReport();
}
