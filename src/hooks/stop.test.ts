import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { mockHeldResult, mockIdentities, mockLeakResult } from '../mocks/fixtures.js';
import { RealRatchet } from '../ratchet/ratchet.js';
import { notyoursPaths } from '../ratchet/paths.js';
import { engineOracle } from '../ratchet/replay.js';
import { readAttempts, readDirty, readEscalated, writeAttempts, writeDirty, writeEscalated } from '../ratchet/store.js';
import { FakeKane, lockedBoundary, tempProject } from '../ratchet/testkit.js';
import type { Boundary, Config, Engine, Identity, ProbeResult } from '../types.js';
import { appIndexFile, findAppDirs, scanAppDirs } from './appdir.js';
import { postToolHook } from './post-tool.js';
import { parseHookInput } from './types.js';
import { LAST_LINE, MAX_REPORT_LINES, STALE_ATTEMPTS_KEY, stopHook, type StopDeps, leakBlock, formatLeakReport } from './stop.js';
import { writeSurfaceBaseline } from './surface-scan.js';
import { checkAppFreshness, STALE_MESSAGE, type FreshnessDeps } from './app-freshness.js';

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
  freshness: async () => ({ status: 'fresh' }), // the stale-app check has its own tests below
  replay: (ids, ctx) => new RealRatchet({ projectDir: ctx.projectDir, kane, oracle: engineOracle(engine) }).replayIds(ctx.identities, ids),
});
const dirtyNotes = () =>
  writeDirty(notyoursPaths(project), {
    'notes-cross-user': { files: ['src/app/api/notes/route.ts'], globs: ['src/app/api/notes/**'], ts: '2026-11-18T12:00:00.000Z' },
  });

beforeEach(() => {
  vi.stubEnv('XDG_CACHE_HOME', mkdtempSync(path.join(os.tmpdir(), 'ny-cache-'))); // keep the app index out of ~/.cache
  project = tempProject();
  kane = new FakeKane();
});
afterEach(() => vi.unstubAllEnvs());

describe('stop hook', () => {
  it('a Bash edit (no PostToolUse) under a locked surface is still replayed on Stop', async () => {
    const p = notyoursPaths(project);
    mkdirSync(path.join(project, 'src/app/api/notes'), { recursive: true });
    writeFileSync(path.join(project, 'src/app/api/notes/route.ts'), 'v1\n');
    writeSurfaceBaseline(project, [lockedBoundary]);
    writeFileSync(path.join(project, 'src/app/api/notes/route.ts'), 'v2, edited with sed -i\n');
    const t = new Date(Date.now() + 5000);
    utimesSync(path.join(project, 'src/app/api/notes/route.ts'), t, t);
    const engine = new SequenceEngine([leak]);
    const r = await stopHook(input('stop-first', project), deps(engine));
    expect(engine.calls).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('src/app/api/notes/route.ts');
    void p;
  });

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
    expect(red.stderr).toContain('npx github:Jasekeee/notyours replay notes-cross-user');
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

  it('escalates on the 3rd RED: writes ESCALATION.md and KEEPS blocking (AUD-11), without new Kane runs', async () => {
    const engine = new SequenceEngine([leak, leak, leak]);
    const p = notyoursPaths(project);
    dirtyNotes();
    expect((await stopHook(input('stop-first', project), deps(engine))).exitCode).toBe(2);
    expect((await stopHook(input('stop-continuation', project), deps(engine))).exitCode).toBe(2);
    expect(existsSync(p.escalation)).toBe(false);

    const third = await stopHook(input('stop-continuation', project), deps(engine));
    expect(third.exitCode).toBe(2); // not silently released
    expect(third.stderr).toContain('ESCALATED, still blocking');
    expect(third.stderr).toContain('npx github:Jasekeee/notyours release notes-cross-user');
    expect(third.stderr).toContain('Stop retrying and tell the user');
    const esc = readFileSync(p.escalation, 'utf8');
    expect(esc).toContain("bob saw alice's data");
    expect(esc).toContain('**Attempts:** 3');
    expect(esc).toContain('.notyours/runs/r1/bob-notes.png');
    expect(esc).toContain('notyours release');
    expect(esc).not.toContain('fake-pw-');
    expect(readAttempts(p)).toEqual({ 'notes-cross-user': 3 });
    expect(readDirty(p)).toHaveProperty('notes-cross-user'); // still pending, not dropped
    expect(readEscalated(p)['notes-cross-user']?.reason).toMatch(/still leaking/);

    // 4th stop, code unchanged: blocks again at once; the engine (Kane) is not called again (it has no results left).
    const callsBefore = engine.calls.length;
    const fourth = await stopHook(input('stop-continuation', project), deps(engine));
    expect(fourth.exitCode).toBe(2);
    expect(fourth.stderr).toContain('ESCALATED, still blocking');
    expect(engine.calls.length).toBe(callsBefore);
  });

  it('an edit under an escalated boundary replays it again; GREEN clears the escalation', async () => {
    const p = notyoursPaths(project);
    mkdirSync(path.join(project, 'src/app/api/notes'), { recursive: true });
    const f = path.join(project, 'src/app/api/notes/route.ts');
    writeFileSync(f, 'v1\n');
    utimesSync(f, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    dirtyNotes();
    writeAttempts(p, { 'notes-cross-user': 3 });
    writeEscalated(p, { 'notes-cross-user': { ts: new Date(Date.now() - 30_000).toISOString(), reason: 'still leaking (LEAK_VISIBLE)' } });
    writeSurfaceBaseline(project, [lockedBoundary]);
    writeFileSync(f, 'v2: fixed\n'); // the agent fixed it after the escalation
    const engine = new SequenceEngine([mockHeldResult]);
    const r = await stopHook(input('stop-continuation', project), deps(engine));
    expect(engine.calls.map((b) => b.id)).toEqual(['notes-cross-user']);
    expect(r.exitCode).toBe(0);
    expect(readEscalated(p)).toEqual({});
    expect(readDirty(p)).toEqual({});
  });

  it('stop_hook_active (a continuation we caused) is not a way out: a RED still blocks', async () => {
    dirtyNotes();
    const r = await stopHook(input('stop-continuation', project), deps(new SequenceEngine([leak])));
    expect(input('stop-continuation', project).stop_hook_active).toBe(true);
    expect(r.exitCode).toBe(2);
  });

  it('honours config maxAttempts and pre-existing attempts', async () => {
    const engine = new SequenceEngine([leak]);
    dirtyNotes();
    writeAttempts(notyoursPaths(project), { 'notes-cross-user': 2 });
    const r = await stopHook(input('stop-continuation', project), deps(engine));
    expect(r.exitCode).toBe(2);
    expect(existsSync(notyoursPaths(project).escalation)).toBe(true);
  });

  it('plan-gate leak report says the free user got the Pro-only result (not someone else\'s data)', () => {
    const b = { ...lockedBoundary, kind: 'plan-gate' as const, proAction: { objective: 'Export' } };
    const text = formatLeakReport([leakBlock(b, leak, undefined, 1, 3, mockIdentities)], []);
    expect(text).toContain('(free plan) got the Pro-only result');
    expect(text).not.toContain("saw alice's data");
  });

  it('a failed Kane replay step does not hide a leak: the oracle still judges (RED blocks)', async () => {
    const engine = new SequenceEngine([mockLeakResult]);
    kane.replayStatus = (req) => (req.identity === 'bob' ? 'failed' : 'passed');
    dirtyNotes();
    const r = await stopHook(input('stop-first', project), deps(engine));
    expect(engine.calls).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('LEAK in boundary notes-cross-user');
  });

  it('HARNESS_BROKEN on a changed locked boundary blocks too (AUD-11): it is not a pass', async () => {
    const engine = new SequenceEngine([{ ...mockHeldResult, verdict: 'HARNESS_BROKEN', controls: { ownerSeesOwnToken: true, viewerSeesOwnToken: false } }]);
    dirtyNotes();
    const r = await stopHook(input('stop-first', project), deps(engine));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('COULD NOT CHECK notes-cross-user');
    expect(r.stderr).toContain('did not see its own token');
    expect(r.stderr).toContain('--reauthor notes-cross-user');
    expect(readAttempts(notyoursPaths(project))['notes-cross-user']).toBe(1);
    expect(readDirty(notyoursPaths(project))).toHaveProperty('notes-cross-user');
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

  it('a replay crash blocks (fail closed, AUD-11), keeps the boundary dirty, and escalates after maxAttempts', async () => {
    dirtyNotes();
    const crash: StopDeps = { env: {}, freshness: async () => ({ status: 'fresh' }), replay: async () => { throw new Error('kane-cli not found'); } };
    const r = await stopHook(input('stop-first', project), crash);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('COULD NOT CHECK notes-cross-user: the replay failed');
    expect(r.stderr).toContain('kane-cli not found');
    expect(readDirty(notyoursPaths(project))).toHaveProperty('notes-cross-user');
    await stopHook(input('stop-continuation', project), crash);
    const third = await stopHook(input('stop-continuation', project), crash);
    expect(third.exitCode).toBe(2);
    expect(third.stderr).toContain('ESCALATED, still blocking');
    expect(readEscalated(notyoursPaths(project))['notes-cross-user']?.reason).toContain('kane-cli not found');
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

  it('reaches an app folder the scan misses (deep, under a dot folder) through the post-tool index', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'ny-repo-'));
    const deep = path.join(repo, '.hidden', 'a', 'b', 'c', 'd', 'e', 'f', 'app');
    mkdirSync(path.dirname(deep), { recursive: true });
    renameSync(project, deep);
    expect(scanAppDirs(repo)).toEqual([]); // too deep for the scan
    mkdirSync(path.join(deep, 'src', 'app', 'api', 'notes'), { recursive: true });
    await postToolHook(parseHookInput(JSON.stringify({ cwd: repo, tool_name: 'Edit', tool_input: { file_path: `${deep}/src/app/api/notes/route.ts` } })), { CLAUDE_PROJECT_DIR: repo });
    const seen: string[] = [];
    const r = await stopHook(input('stop-first', repo), {
      env: { CLAUDE_PROJECT_DIR: repo },
      replay: async (ids, ctx) => (seen.push(ctx.projectDir), ids.map((boundaryId) => ({ ...mockHeldResult, boundaryId }))),
    });
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual([deep]);
    expect(readDirty(notyoursPaths(deep))).toEqual({});
  });

  it('ignores index entries outside the project (planted or stale)', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'ny-repo-'));
    const outside = tempProject(); // a real app folder, but not under repo
    dirtyNotes(); // `project` is outside repo too
    mkdirSync(path.dirname(appIndexFile(repo)), { recursive: true });
    writeFileSync(appIndexFile(repo), JSON.stringify([outside, project, '/etc', 'relative/dir']));
    expect(findAppDirs(repo)).toEqual([]);
    expect(await stopHook(input('stop-first', repo), { env: { CLAUDE_PROJECT_DIR: repo }, replay: async () => { throw new Error('must not replay'); } })).toEqual({ exitCode: 0 });
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

describe('stop hook: stale app server', () => {
  const withFreshness = (engine: Engine, freshness: StopDeps['freshness']): StopDeps => ({ ...deps(engine), freshness });

  it('app server older than the code: YELLOW, no replay, exit 2, boundary stays dirty', async () => {
    dirtyNotes();
    const engine = new SequenceEngine([]);
    const r = await stopHook(input('stop-first', project), withFreshness(engine, async () => ({ status: 'stale', message: `notyours: YELLOW. ${STALE_MESSAGE}.` })));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(STALE_MESSAGE);
    expect(r.stderr).not.toContain(LAST_LINE); // not a leak report
    expect(engine.calls).toEqual([]);
    expect(kane.replayed).toEqual([]);
    expect(Object.keys(readDirty(notyoursPaths(project)))).toEqual(['notes-cross-user']);
    expect(readAttempts(notyoursPaths(project))[STALE_ATTEMPTS_KEY]).toBe(1);
  });

  it('app.start not approved on this machine: YELLOW with the approve command, exit 2, no replay', async () => {
    dirtyNotes();
    const engine = new SequenceEngine([]);
    const unapproved = withFreshness(engine, async () => ({ status: 'unapproved', message: 'notyours: YELLOW. app.start has not been approved.\n    npx github:Jasekeee/notyours init' }));
    const r = await stopHook(input('stop-first', project), unapproved);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('npx github:Jasekeee/notyours init');
    expect(engine.calls).toEqual([]);
    expect(kane.replayed).toEqual([]);
    expect(readAttempts(notyoursPaths(project))[STALE_ATTEMPTS_KEY]).toBe(1);
  });

  it('after maxAttempts stale stops it escalates and keeps blocking; a fresh server clears it', async () => {
    dirtyNotes();
    const stale = withFreshness(new SequenceEngine([]), async () => ({ status: 'stale', message: 'stale!' }));
    expect((await stopHook(input('stop-first', project), stale)).exitCode).toBe(2);
    expect((await stopHook(input('stop-first', project), stale)).exitCode).toBe(2);
    const third = await stopHook(input('stop-first', project), stale); // maxAttempts = 3
    expect(third.exitCode).toBe(2);
    expect(third.stderr).toContain('ESCALATED, still blocking');
    expect(readEscalated(notyoursPaths(project))[STALE_ATTEMPTS_KEY]?.ids).toEqual(['notes-cross-user']);
    const fresh = await stopHook(input('stop-first', project), withFreshness(new SequenceEngine([mockHeldResult]), async () => ({ status: 'fresh' })));
    expect(fresh.exitCode).toBe(0);
    expect(readEscalated(notyoursPaths(project))).toEqual({});
  });

  it('app.start restarted the app: replays as usual and clears the stale counter', async () => {
    dirtyNotes();
    writeAttempts(notyoursPaths(project), { [STALE_ATTEMPTS_KEY]: 1 });
    const engine = new SequenceEngine([mockHeldResult]);
    const r = await stopHook(input('stop-first', project), withFreshness(engine, async () => ({ status: 'restarted', note: 'notyours: restarted the app (app.start) on :3000 before replaying.' })));
    expect(r.exitCode).toBe(0);
    expect(engine.calls.map((b) => b.id)).toEqual(['notes-cross-user']);
    expect(readAttempts(notyoursPaths(project))[STALE_ATTEMPTS_KEY]).toBeUndefined();
  });

  it('end to end with the real check: a server started before the edit is stale', async () => {
    const p = notyoursPaths(project);
    mkdirSync(path.join(project, 'src/app/api/notes'), { recursive: true });
    writeFileSync(path.join(project, 'src/app/api/notes/route.ts'), 'edited just now\n');
    dirtyNotes();
    const fake: FreshnessDeps = { listeners: () => [4242], ageSeconds: () => 3600, now: () => Date.now(), restart: async () => { throw new Error('not configured'); } };
    const engine = new SequenceEngine([]);
    const r = await stopHook(input('stop-first', project), withFreshness(engine, (dir, paths, baseUrl, bs) => checkAppFreshness(dir, paths, baseUrl, bs, fake)));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/pid 4242\) started at .*, but src\/app\/api\/notes\/route\.ts changed at/);
    expect(engine.calls).toEqual([]);
    void p;
  });
});

describe('stop hook: no way to switch it off from a boundary file (AUD-2 P0)', () => {
  const bdir = () => { const d = notyoursPaths(project).boundariesDir; mkdirSync(d, { recursive: true }); return d; };

  it('an invalid boundary file blocks (it used to exit 0 with a note), with or without dirty boundaries', async () => {
    writeFileSync(path.join(bdir(), 'zz-broken.yaml'), 'id: broken\nkind: not-a-kind\n');
    const engine = new SequenceEngine([]);
    // Nothing marked dirty yet: the surface scan can't read the boundaries, so the app is still checked.
    const clean = await stopHook(input('stop-first', project), deps(engine));
    expect(clean.exitCode).toBe(2);
    expect(clean.stderr).toContain('COULD NOT CHECK');
    expect(clean.stderr).toContain('zz-broken.yaml');
    dirtyNotes();
    const withDirty = await stopHook(input('stop-first', project), deps(engine));
    expect(withDirty.exitCode).toBe(2);
    expect(engine.calls).toEqual([]); // nothing was replayed against a boundary set that can't be trusted
  });

  it('an unlocked copy reusing a locked boundary id blocks (it used to exit 0 and empty dirty.json)', async () => {
    writeFileSync(path.join(bdir(), 'zz-copy.yaml'), YAML.stringify({ ...lockedBoundary, locked: false }));
    dirtyNotes();
    const r = await stopHook(input('stop-first', project), deps(new SequenceEngine([mockHeldResult])));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(`duplicate boundary id "${lockedBoundary.id}"`);
    expect(readDirty(notyoursPaths(project))).toHaveProperty(lockedBoundary.id); // still pending
  });
});
