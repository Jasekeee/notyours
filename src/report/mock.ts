import path from 'node:path';
import type { ProbeResult, Report } from '../types.js';

/** Writes nothing; returns the path a real report would be written to. */
export class MockReport implements Report {
  write(_results: ProbeResult[], outDir: string): string {
    return path.join(outDir, 'report.md');
  }
}
