import { existsSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHeldResult, mockIdentities, mockLeakResult } from '../mocks/fixtures.js';
import { RealRatchet } from '../ratchet/ratchet.js';
import { notyoursPaths } from '../ratchet/paths.js';
import { engineOracle } from '../ratchet/replay.js';
import { readAttempts, readDirty, writeAttempts, writeDirty } from '../ratchet/store.js';
import { FakeKane, lockedBoundary, tempProject } from '../ratchet/testkit.js';
import type { Boundary, Config, Engine, Identity, ProbeResult } from '../types.js';
import { parseHookInput } from './types.js';
import { LAST_LINE, MAX_REPORT_LINES, stopHook, type StopDeps } from './stop.js';
import { formatLeakReport } from './stop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const input = (name: string, project: string) =>
  parseHookInput(readFileSync(path.join(here, 'fixtures', `${name}.json`), 'utf8').replaceAll('__PROJECT__', project));

/** Engine double: returns the scripted verdicts in order, one per runBoundary() call. */
class SequenceEngine implements Engine {
  calls: Boundary[] = [];
  constructor(private readonly seq: ProbeResult[]) {}
  async runBoundary(b: Boundary, _ids: Identity[], _cfg: Config): Promise<ProbeResult> {
    this.calls.push(b);
    const r = this.seq.shift();
    if (!r) throw new Error('no more scripted results');
    return { ...r, boundaryId: b.id };
  }
}

const leak: ProbeResult = { ...mockLeakResult, screenshots: ['.notyours/runs/r1/bob-notes.png'] };

let project: string;
let kane: FakeKane;
const deps = (engine: Engine): StopDeps => ({
  env: {},
  replay: (ids, ctx) => new RealRatchet({ projectDir: ctx.projectDir, kane, oracle: engineOracle(engine) }).replayIds(ctx.identities, ids),
});
const dirtyNotes = () =>
  writeDirty(notyoursPaths(project), {
    'notes-cross-user': { files: ['src/app/api/notes/route.ts'], globs: ['src/app/api/notes/**'], ts: '2026-11-18T12:00:00.000Z' },
  });

beforeEach(() => {
  project = tempProject();
  kane = new FakeKane();
});
afterEach(() => vi.unstubAllEnvs());

describe('stop hook', () => {
  it('exits 0 immediately when dirty.json is empty or missing (no replay)', async () => {
    const engine = new SequenceEngine([]);
    expect(await stopHook(input('stop-first', project), deps(engine))).toEqual({ exitCode: 0 });
    expect(kane.replayed).toHaveLength(0);
  });

  it('RED then GREEN: blocks with a leak report, then clears dirty and attempts', async () => {
    const engine = new SequenceEngine([leak, mockHeldResult]);
    dirtyNotes();

    const red = await stopHook(input('stop-first', project), deps(engine));
    expect(red.exitCode).toBe(2);
    const lines = red.stderr!.trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(MAX_REPORT_LINES);
    expect(lines.at(-1)).toBe(LAST_LINE);
    expect(red.stderr).toContain('notes-cross-user (cross-user)');
    expect(red.stderr).toContain("bob saw alice's data");
    expect(red.stderr).toContain('URL: http://127.0.0.1:3000/api/notes');
    expect(red.stderr).toContain('PAYLOAD');
    expect(red.stderr).toContain('NY-ALICE-AAAAAAAAAAAA');
    expect(red.stderr).toContain('Screenshot: .notyours/runs/r1/bob-notes.png');
    expect(red.stderr).toContain('src/app/api/notes/route.ts (matched src/app/api/notes/**)');
    expect(red.stderr).toContain('npx notyours replay notes-cross-user');
    expect(readAttempts(notyoursPaths(project))).toEqual({ 'notes-cross-user': 1 });
    expect(readDirty(notyoursPaths(project))).toHaveProperty('notes-cross-user');
    // owner and viewer replayed in their own Chromes
    expect(kane.replayed.map((r) => r.cdpEndpoint).sort()).toEqual(['http://127.0.0.1:9301', 'http://127.0.0.1:9302']);
    expect(engine.calls[0]?.locked).toBe(true);

    const green = await stopHook(input('stop-continuation', project), deps(engine));
    expect(green).toEqual({ exitCode: 0 });
    expect(readDirty(notyoursPaths(project))).toEqual({});
    expect(readAttempts(notyoursPaths(project))).toEqual({});
  });

  it('escalates on the 3rd RED: writes ESCALATION.md, exits 0, tells the human', async () => {
    const engine = new SequenceEngine([leak, leak, leak]);
    const p = notyoursPaths(project);
    dirtyNotes();
    expect((await stopHook(input('stop-first', project), deps(engine))).exitCode).toBe(2);
    expect((await stopHook(input('stop-continuation', project), deps(engine))).exitCode).toBe(2);
    expect(existsSync(p.escalation)).toBe(false);

    const third = await stopHook(input('stop-continuation', project), deps(engine));
    expect(third.exitCode).toBe(0);
    expect(JSON.parse(third.stdout!).systemMessage).toContain('ESCALATION.md');
    const esc = readFileSync(p.escalation, 'utf8');
    expect(esc).toContain("bob saw alice's data");
    expect(esc).toContain('**Attempts:** 3');
    expect(esc).toContain('.notyours/runs/r1/bob-notes.png');
    expect(esc).not.toContain('fake-pw-');
    expect(readAttempts(p)).toEqual({ 'notes-cross-user': 3 });
    expect(readDirty(p)).toEqual({}); // the human owns it now
  });

  it('honours config maxAttempts and pre-existing attempts', async () => {
    const engine = new SequenceEngine([leak]);
    dirtyNotes();
    writeAttempts(notyoursPaths(project), { 'notes-cross-user': 2 });
    const r = await stopHook(input('stop-continuation', project), deps(engine));
    expect(r.exitCode).toBe(0);
    expect(existsSync(notyoursPaths(project).escalation)).toBe(true);
  });

  it('YELLOW when a Kane replay step fails: exit 0, human message, oracle not called, dirty kept', async () => {
    const engine = new SequenceEngine([]);
    kane.replayStatus = (req) => (req.identity === 'bob' ? 'failed' : 'passed');
    dirtyNotes();
    const r = await stopHook(input('stop-first', project), deps(engine));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout!).systemMessage).toContain('harness needs re-recording: notyours lock --reauthor notes-cross-user');
    expect(engine.calls).toHaveLength(0);
    expect(readDirty(notyoursPaths(project))).toHaveProperty('notes-cross-user');
    expect(readAttempts(notyoursPaths(project))).toEqual({});
  });

  it('YELLOW when the oracle says HARNESS_BROKEN', async () => {
    const engine = new SequenceEngine([{ ...mockHeldResult, verdict: 'HARNESS_BROKEN' }]);
    dirtyNotes();
    const r = await stopHook(input('stop-first', project), deps(engine));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('--reauthor notes-cross-user');
  });

  it('does not replay unlocked boundaries; tells the human instead', async () => {
    project = tempProject([{ ...lockedBoundary, locked: false }]);
    const engine = new SequenceEngine([]);
    dirtyNotes();
    const r = await stopHook(input('stop-first', project), deps(engine));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('not locked yet');
    expect(kane.replayed).toHaveLength(0);
  });

  it('scrubs identity passwords out of leaked snippets', async () => {
    const pw = mockIdentities[0]!.password!;
    const engine = new SequenceEngine([{ ...leak, hits: [{ ...leak.hits[0]!, snippet: `{"title":"NY-ALICE-AAAAAAAAAAAA","pw":"${pw}"}` }] }]);
    dirtyNotes();
    const r = await stopHook(input('stop-first', project), deps(engine));
    expect(r.stderr).not.toContain(pw);
    expect(r.stderr).toContain('[REDACTED]');
  });

  it('a replay crash tells the human and keeps the boundary dirty', async () => {
    dirtyNotes();
    const r = await stopHook(input('stop-first', project), { env: {}, replay: async () => { throw new Error('kane-cli not found'); } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('kane-cli not found');
    expect(readDirty(notyoursPaths(project))).toHaveProperty('notes-cross-user');
  });
});

describe('stop hook with the app in a subfolder (demo/)', () => {
  it('finds demo/.notyours, replays there, and shows project-relative suspected files', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'ny-repo-'));
    const demo = path.join(repo, 'demo');
    renameSync(project, demo);
    project = demo;
    writeDirty(notyoursPaths(demo), {
      'notes-cross-user': { files: ['routes/notes.js'], globs: ['routes/notes.js'], ts: '2026-11-18T12:00:00.000Z' },
    });
    const seen: string[] = [];
    const engine = new SequenceEngine([leak, mockHeldResult]);
    const d: StopDeps = {
      env: { CLAUDE_PROJECT_DIR: repo },
      replay: (ids, ctx) => {
        seen.push(ctx.projectDir);
        return new RealRatchet({ projectDir: ctx.projectDir, kane, oracle: engineOracle(engine) }).replayIds(ctx.identities, ids);
      },
    };
    const red = await stopHook(input('stop-first', repo), d);
    expect(red.exitCode).toBe(2);
    expect(seen).toEqual([demo]);
    expect(red.stderr).toContain('Suspected files: demo/routes/notes.js (matched demo/routes/notes.js)');
    expect(readAttempts(notyoursPaths(demo))).toEqual({ 'notes-cross-user': 1 });
    expect((await stopHook(input('stop-continuation', repo), d)).exitCode).toBe(0);
    expect(readDirty(notyoursPaths(demo))).toEqual({});
  });

  it('exits 0 fast when no app folder has dirty boundaries', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'ny-repo-'));
    renameSync(project, path.join(repo, 'demo'));
    expect(await stopHook(input('stop-first', repo), { env: { CLAUDE_PROJECT_DIR: repo }, replay: async () => { throw new Error('must not replay'); } })).toEqual({ exitCode: 0 });
  });
});

describe('formatLeakReport', () => {
  it('caps at 40 lines and keeps the last line', () => {
    const blocks = Array.from({ length: 10 }, (_, n) => [`notyours: LEAK in boundary b${n}`, 'a', 'b', 'c', 'd', 'e']);
    const lines = formatLeakReport(blocks, ['x']).trimEnd().split('\n');
    expect(lines).toHaveLength(MAX_REPORT_LINES);
    expect(lines.at(-1)).toBe(LAST_LINE);
  });
});
