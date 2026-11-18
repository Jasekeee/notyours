// Test helpers shared by src/ratchet and src/hooks tests. Not imported by production code.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { mockBoundary, mockHeldResult, mockIdentities } from '../mocks/fixtures.js';
import type { Boundary, KaneRun, ProbeResult } from '../types.js';
import type { AuthorRequest, KaneClient, ReplayOutcome, ReplayRequest } from './kane.js';
import { notyoursPaths } from './paths.js';

export const lockedBoundary: Boundary = { ...mockBoundary, locked: true };

/** A HELD result whose owner create run stored note_url, as the engine would return it. */
export const heldWithUrl: ProbeResult = {
  ...mockHeldResult,
  kaneRuns: [{ ...mockHeldResult.kaneRuns[0]!, finalState: { note_url: 'http://127.0.0.1:3000/notes/7' } }],
};

export function tempProject(boundaries: Boundary[] = [lockedBoundary], opts: { comment?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ny-c-'));
  const p = notyoursPaths(dir);
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.config, 'baseUrl: http://127.0.0.1:3000\nmaxAttempts: 3\n');
  const body = YAML.stringify({ boundaries });
  writeFileSync(p.boundariesFile, opts.comment ? `# hand-written boundaries\n${body}` : body);
  writeFileSync(p.secrets, JSON.stringify({ identities: mockIdentities }));
  return dir;
}

export function passedRun(identity: string, objective = 'replay'): KaneRun {
  return { objective, identity, status: 'passed', exitCode: 0, finalState: {}, creditsConsumed: 0, durationS: 0.6 };
}

/** In-memory KaneClient. author() writes the files kane-cli would write; replay() returns scripted outcomes. */
export class FakeKane implements KaneClient {
  authored: AuthorRequest[] = [];
  replayed: ReplayRequest[] = [];
  balanceValue: number | undefined = 10_000;
  authorStatus: KaneRun['status'] = 'passed';
  replayStatus: (req: ReplayRequest) => KaneRun['status'] = () => 'passed';

  async author(req: AuthorRequest): Promise<KaneRun> {
    this.authored.push(req);
    const tests = path.join(req.cwd, '.testmuai', 'tests');
    mkdirSync(path.join(tests, `output-${req.name}`, '.internal'), { recursive: true });
    writeFileSync(path.join(tests, `${req.name}_test.md`), `---\nmode: testing\n---\n\n## Step 1\n${req.objective}\n`);
    writeFileSync(path.join(tests, `output-${req.name}`, '.internal', 'meta.json'), '{}');
    return { ...passedRun(req.identity, req.objective), status: this.authorStatus, creditsConsumed: 12.5 };
  }

  async replay(req: ReplayRequest): Promise<ReplayOutcome> {
    this.replayed.push(req);
    const status = this.replayStatus(req);
    return status === 'passed'
      ? { run: passedRun(req.identity), authorDecisions: 0 }
      : { run: { ...passedRun(req.identity), status, exitCode: 1, reason: 'step 1 failed' }, failedStep: 1, authorDecisions: 0 };
  }

  async balance(): Promise<number | undefined> {
    return this.balanceValue;
  }
}
