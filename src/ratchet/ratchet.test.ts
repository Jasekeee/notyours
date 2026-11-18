import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { MOCK_TS, mockHeldResult, mockIdentities, mockLeakResult, mockKaneRun } from '../mocks/fixtures.js';
import type { Engine, ProbeResult } from '../types.js';
import { createRatchet, MockRatchet, RealRatchet } from './index.js';
import { KaneCli, parseAuthorRun, parseBalance, parseReplay } from './kane.js';
import { planLock, probeRunsPassed, resolveTemplate } from './lock.js';
import { notyoursPaths, testFile } from './paths.js';
import { classify, engineOracle } from './replay.js';
import { loadIdentities, logCredits, readCreditLog } from './store.js';
import { FakeKane, heldWithUrl, lockedBoundary, tempProject } from './testkit.js';

const unlocked = { ...lockedBoundary, locked: false };

describe('createRatchet', () => {
  it('returns the mock without a project dir, the real one with it', () => {
    expect(createRatchet()).toBeInstanceOf(MockRatchet);
    expect(createRatchet({ projectDir: os.tmpdir() })).toBeInstanceOf(RealRatchet);
  });
});

describe('lock', () => {
  let project: string;
  let kane: FakeKane;
  const ratchet = (extra = {}) => new RealRatchet({ projectDir: project, kane, identities: mockIdentities, ...extra });
  beforeEach(() => {
    project = tempProject([unlocked], { comment: true });
    kane = new FakeKane();
  });

  it('adopts the probe\'s own recordings (same names) instead of authoring: 0 runs', async () => {
    const p = notyoursPaths(project);
    mkdirSync(p.kaneTests, { recursive: true });
    for (const id of ['alice', 'bob']) {
      writeFileSync(path.join(p.kaneTests, `notes-cross-user_${id}_test.md`), '## Step 1\nrecorded by the probe\n');
      mkdirSync(path.join(p.kaneTests, `output-notes-cross-user_${id}`), { recursive: true });
      writeFileSync(path.join(p.kaneTests, `output-notes-cross-user_${id}`, '.env.example'), 'LT_USERNAME=\n');
    }
    await ratchet().lock(unlocked, heldWithUrl);
    expect(kane.authored).toEqual([]);
    for (const id of ['alice', 'bob']) {
      expect(readFileSync(testFile(p, 'notes-cross-user', id), 'utf8')).toContain('recorded by the probe');
      expect(existsSync(path.join(p.tests, `output-notes-cross-user_${id}`, '.env.example'))).toBe(false);
    }
    expect(YAML.parse(readFileSync(p.boundariesFile, 'utf8')).boundaries[0].locked).toBe(true);
    expect(readCreditLog(p).filter((e) => e.kind === 'author')).toEqual([]);
  });

  it('records owner + viewer tests, moves them (with recordings) into .notyours/tests, sets locked:true', async () => {
    await ratchet().lock(unlocked, heldWithUrl);
    const p = notyoursPaths(project);
    expect(kane.authored.map((a) => [a.name, a.cdpEndpoint])).toEqual([
      ['notes-cross-user_alice', 'http://127.0.0.1:9301'],
      ['notes-cross-user_bob', 'http://127.0.0.1:9302'],
    ]);
    expect(kane.authored[0]?.objective).toBe(
      "Go to http://127.0.0.1:3000/notes/new, create a note titled 'NY-ALICE-AAAAAAAAAAAA', save it, store the note URL as 'note_url'",
    );
    expect(kane.authored[1]?.objective).toBe('Go to http://127.0.0.1:3000/notes/7, then go to http://127.0.0.1:3000/api/notes');
    for (const id of ['alice', 'bob']) {
      expect(existsSync(testFile(p, 'notes-cross-user', id))).toBe(true);
      expect(existsSync(path.join(p.tests, `output-notes-cross-user_${id}`, '.internal', 'meta.json'))).toBe(true);
      expect(existsSync(path.join(p.tests, `output-notes-cross-user_${id}`, 'playwright-python-code', 'test.py'))).toBe(true);
      expect(existsSync(path.join(p.tests, `output-notes-cross-user_${id}`, 'playwright-python-code', '.env.example'))).toBe(false);
      expect(existsSync(path.join(p.kaneTests, `notes-cross-user_${id}_test.md`))).toBe(false);
    }
    const yaml = readFileSync(p.boundariesFile, 'utf8');
    expect(yaml).toContain('# hand-written boundaries');
    expect(YAML.parse(yaml).boundaries[0].locked).toBe(true);
    expect(readCreditLog(p).map((e) => [e.kind, e.name, e.credits])).toEqual([
      ['author', 'notes-cross-user_alice', 12.5],
      ['author', 'notes-cross-user_bob', 12.5],
    ]);
  });

  it('is idempotent: a second lock spends no credits', async () => {
    await ratchet().lock(unlocked, heldWithUrl);
    await ratchet().lock(unlocked, heldWithUrl);
    expect(kane.authored).toHaveLength(2);
  });

  it('re-authors with reauthor:true', async () => {
    await ratchet().lock(unlocked, heldWithUrl);
    await ratchet({ reauthor: true }).lock(unlocked, heldWithUrl);
    expect(kane.authored).toHaveLength(4);
  });

  it.each<[string, ProbeResult]>([
    ['a leak', mockLeakResult],
    ['HELD without the owner control', { ...heldWithUrl, controls: { ownerSeesOwnToken: false, viewerSeesOwnToken: true } }],
    ['HELD without the viewer control', { ...heldWithUrl, controls: { ownerSeesOwnToken: true, viewerSeesOwnToken: false } }],
    ['a result for another boundary', { ...heldWithUrl, boundaryId: 'other' }],
  ])('refuses %s without authoring', async (_n, result) => {
    await expect(ratchet().lock(unlocked, result)).rejects.toThrow();
    expect(kane.authored).toHaveLength(0);
  });

  it('refuses when a target variable was never stored', async () => {
    await expect(ratchet().lock(unlocked, mockHeldResult)).rejects.toThrow(/note_url/);
    expect(kane.authored).toHaveLength(0);
  });

  it('refuses below the credit floor or when the balance is unreadable', async () => {
    kane.balanceValue = 100;
    await expect(ratchet().lock(unlocked, heldWithUrl)).rejects.toThrow(/creditFloor/);
    kane.balanceValue = undefined;
    await expect(ratchet().lock(unlocked, heldWithUrl)).rejects.toThrow(/balance/);
    expect(kane.authored).toHaveLength(0);
  });

  it('defaults to a budget of 8 authoring runs (4 boundaries)', async () => {
    const p = notyoursPaths(project);
    for (let n = 0; n < 7; n++) logCredits(p, { ts: MOCK_TS, kind: 'author', name: `x${n}`, identity: 'alice', status: 'passed', credits: 30 });
    await expect(ratchet().lock(unlocked, heldWithUrl)).rejects.toThrow(/budget reached \(7\/8/);
    expect(kane.authored).toHaveLength(0);
  });

  it('enforces the authoring-run budget', async () => {
    await expect(ratchet({ maxAuthoringRuns: 1 }).lock(unlocked, heldWithUrl)).rejects.toThrow(/budget/);
    expect(kane.authored).toHaveLength(0);
  });

  it('stops after a failed owner recording (viewer credits not spent), boundary stays unlocked', async () => {
    kane.authorStatus = 'failed';
    await expect(ratchet().lock(unlocked, heldWithUrl)).rejects.toThrow(/not locked/);
    expect(kane.authored).toHaveLength(1);
    expect(YAML.parse(readFileSync(notyoursPaths(project).boundariesFile, 'utf8')).boundaries[0].locked).toBe(false);
  });

  it('plan-gate records a plain visit of the GET targets for the viewer, never the (refused) pro action', () => {
    const b = { ...unlocked, kind: 'plan-gate' as const, viewer: 'free_user', proAction: { objective: 'Go to {{note_url}} and click Export PDF' } };
    expect(planLock(b, heldWithUrl, mockIdentities)[1]?.objective).toBe('Go to http://127.0.0.1:3000/notes/7, then go to http://127.0.0.1:3000/api/notes');
  });

  it('only adopts probe recordings whose runs passed (a refused plan-gate pro action is fine)', () => {
    const ok = { ...mockHeldResult, kaneRuns: [{ ...mockKaneRun, identity: 'alice' }, { ...mockKaneRun, identity: 'bob' }] };
    expect(probeRunsPassed(unlocked, ok)).toBe(true);
    const failedVisit = { ...ok, kaneRuns: [ok.kaneRuns[0]!, { ...mockKaneRun, identity: 'bob', status: 'failed' as const }] };
    expect(probeRunsPassed(unlocked, failedVisit)).toBe(false);
    const pg = { ...unlocked, kind: 'plan-gate' as const, proAction: { objective: 'Export my notes' } };
    const refused = { ...ok, kaneRuns: [...ok.kaneRuns, { ...mockKaneRun, identity: 'bob', objective: 'Export my notes', status: 'failed' as const }] };
    expect(probeRunsPassed(pg, refused)).toBe(true);
    const paywalledVisit = { ...ok, kaneRuns: [ok.kaneRuns[0]!, { ...mockKaneRun, identity: 'bob', objective: 'Go to x', status: 'failed' as const, reason: 'blocker.paywall' }] };
    expect(probeRunsPassed(pg, paywalledVisit)).toBe(true);
    expect(probeRunsPassed(unlocked, paywalledVisit)).toBe(false); // only a plan-gate may be refused
  });

  // Shapes from the Jotter demo (feat/demo: demo/.notyours/boundaries/b1-cross-user.yaml, b3-plan-gate.yaml).
  const demoB1 = {
    id: 'b1-notes-cross-user', kind: 'cross-user' as const, owner: 'alice', viewer: 'bob',
    create: { objective: "Go to http://127.0.0.1:3077/notes/1001, verify the note text contains '{{token}}', and store the current page URL as 'note_url'", store: ['note_url'] },
    targets: { ui: ['http://127.0.0.1:3077/notes/1001'], api: ['http://127.0.0.1:3077/api/notes/1001'] },
    expect: 'denied' as const, surface: ['routes/notes.js'],
  };
  const demoB3 = {
    ...demoB1, id: 'b3-export-plan-gate', kind: 'plan-gate' as const,
    create: { objective: "Go to http://127.0.0.1:3077/pro/export and verify an 'Export my notes' button is visible", store: [] },
    targets: { ui: ['http://127.0.0.1:3077/pro/export'], api: ['POST http://127.0.0.1:3077/api/export'] },
    proAction: { objective: 'Go to http://127.0.0.1:3077/pro/export and export my notes' },
  };

  it('demo B1: owner replays the create check with the real token; viewer visits page then API', () => {
    const [o, v] = planLock(demoB1, { ...mockHeldResult, boundaryId: demoB1.id }, mockIdentities);
    expect(o?.objective).toBe("Go to http://127.0.0.1:3077/notes/1001, verify the note text contains 'NY-ALICE-AAAAAAAAAAAA', and store the current page URL as 'note_url'");
    expect(v?.objective).toBe('Go to http://127.0.0.1:3077/notes/1001, then go to http://127.0.0.1:3077/api/notes/1001');
  });

  it('demo B3 plan-gate: owner checks the pro button, viewer records a visit of the GET target', () => {
    const [o, v] = planLock(demoB3, { ...mockHeldResult, boundaryId: demoB3.id }, mockIdentities);
    expect(o?.objective).toBe(demoB3.create.objective);
    expect(v?.objective).toBe('Go to http://127.0.0.1:3077/pro/export'); // POST /api/export is the oracle's job
    const sweep = planLock({ ...demoB3, kind: 'sweep' }, { ...mockHeldResult, boundaryId: demoB3.id }, mockIdentities)[1];
    expect(sweep?.objective).toBe('Go to http://127.0.0.1:3077/pro/export');
  });

  it('loads identities.json merged with secrets.json by id', () => {
    const p = notyoursPaths(project);
    const noPw = mockIdentities.map(({ password: _pw, ...rest }) => rest);
    writeFileSync(p.identities, JSON.stringify(Object.fromEntries(noPw.map(({ id, ...rest }) => [id, rest]))));
    writeFileSync(p.secrets, JSON.stringify({ alice: { password: 'from-secrets' } })); // notyours:allow-secret (fake fixture)
    const ids = loadIdentities(p);
    expect(ids.map((i) => i.id)).toEqual(['alice', 'bob', 'guest', 'free_user']);
    expect(ids.find((i) => i.id === 'alice')?.password).toBe('from-secrets');
    expect(ids.find((i) => i.id === 'bob')?.password).toBeUndefined();
  });

  it('resolveTemplate fills values and rejects missing ones', () => {
    expect(resolveTemplate('{{ a }}/{{b}}', { a: 'x', b: 1 })).toBe('x/1');
    expect(() => resolveTemplate('{{a}}', {})).toThrow(/a/);
  });
});

describe('replay', () => {
  let project: string;
  beforeEach(() => {
    project = tempProject([lockedBoundary, { ...lockedBoundary, id: 'not-locked', locked: false }]);
  });
  const engine = (r: ProbeResult): Engine => ({ runBoundary: async (b) => ({ ...r, boundaryId: b.id }) });

  it('a failed Kane replay never hides the oracle verdict (the app changed, so the recording diverged)', async () => {
    const kane = new FakeKane();
    kane.replayStatus = (req) => (req.identity === 'bob' ? 'failed' : 'passed');
    const [r] = await new RealRatchet({ projectDir: project, kane, oracle: engineOracle(engine(mockLeakResult)) }).replay(mockIdentities);
    expect(classify(r!)).toBe('RED');
    expect(r!.kaneRuns.some((k) => k.identity === 'bob' && k.status === 'failed')).toBe(true);
  });

  it('replays only locked boundaries, at 0 credits, and returns the oracle verdict with the replay runs', async () => {
    const kane = new FakeKane();
    const results = await new RealRatchet({ projectDir: project, kane, oracle: engineOracle(engine(mockLeakResult)) }).replay(mockIdentities);
    expect(results.map((r) => [r.boundaryId, r.verdict, classify(r)])).toEqual([['notes-cross-user', 'LEAK_PAYLOAD', 'RED']]);
    expect(results[0]?.kaneRuns.filter((k) => k.objective.startsWith('replay'))).toHaveLength(2);
    expect(readCreditLog(notyoursPaths(project)).every((e) => e.kind === 'replay' && e.credits === 0)).toBe(true);
  });

  it('prefers engine.judge() when the engine has one', async () => {
    const judged: string[] = [];
    const e = { ...engine(mockLeakResult), judge: async (b: { id: string }) => (judged.push(b.id), { ...mockHeldResult, boundaryId: b.id }) };
    const results = await new RealRatchet({ projectDir: project, kane: new FakeKane(), oracle: engineOracle(e) }).replay(mockIdentities);
    expect(judged).toEqual(['notes-cross-user']);
    expect(classify(results[0]!)).toBe('GREEN');
  });

  it('classify maps verdicts to lights', () => {
    expect(classify({ ...mockHeldResult, verdict: 'LEAK_VISIBLE' })).toBe('RED');
    expect(classify({ ...mockHeldResult, verdict: 'LEAK_PAYLOAD' })).toBe('RED');
    expect(classify({ ...mockHeldResult, verdict: 'HARNESS_BROKEN' })).toBe('YELLOW');
    expect(classify(mockHeldResult)).toBe('GREEN');
  });
});

describe('kane-cli NDJSON parsing', () => {
  it('parses an authoring run_end', () => {
    const out = [
      '{"type":"stream_start","cli_version":"0.10.0","surface":"run"}',
      '{"step":1,"status":"done","remark":"opened page"}',
      '{"type":"run_end","status":"passed","duration":16.4,"credits_consumed":6.49,"final_state":{"note_url":"http://x/1"},"reason_code":"success.complete","test_url":"https://tm/x"}',
    ].join('\n');
    expect(parseAuthorRun(out, 0, 'obj', 'alice')).toMatchObject({
      status: 'passed', creditsConsumed: 6.49, durationS: 16.4, finalState: { note_url: 'http://x/1' }, testUrl: 'https://tm/x', reason: 'success.complete',
    });
    expect(parseAuthorRun('', 3, 'obj', 'alice').status).toBe('timeout');
  });

  it('parses a passing replay and a replay whose step failed', () => {
    const pass = [
      '{"type":"test_md_step_start","step_index":1,"heading":"Step 1"}',
      '{"type":"run_end","status":"passed","final_state":{"x":"1"}}',
      '{"type":"test_md_step_end","step_index":1,"status":"passed"}',
      '{"type":"test_md_summary","overall_status":"passed","duration_s":0.7,"steps":{"total":1,"passed":1,"failed":0,"replay_decisions":1,"author_decisions":0}}',
      '{"type":"test_md_done","overall_status":"passed","duration_s":0.72,"session_id":"s1"}',
    ].join('\n');
    expect(parseReplay(pass, 0, 't.md', 'bob')).toMatchObject({ run: { status: 'passed', creditsConsumed: 0, durationS: 0.72, finalState: { x: '1' } }, authorDecisions: 0 });

    const fail = '{"type":"test_md_step_end","step_index":2,"status":"failed"}\n{"type":"test_md_done","overall_status":"failed","duration_s":1}';
    expect(parseReplay(fail, 1, 't.md', 'bob')).toMatchObject({ run: { status: 'failed', reason: 'step 2 failed' }, failedStep: 2 });
    expect(parseReplay('{"type":"test_md_summary","overall_status":"passed"}', 0, 't.md', 'bob').run.status).toBe('error');
  });

  it('parses the balance line', () => {
    expect(parseBalance('Available credits: 11121.8322\n')).toBeCloseTo(11121.8322);
    expect(parseBalance('nothing')).toBeUndefined();
  });

  it('KaneCli replays with --no-adaptive-heal and --cdp-endpoint (fake kane-cli binary)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ny-kane-'));
    const bin = path.join(dir, 'kane-cli');
    const argsFile = path.join(dir, 'args');
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho '{"type":"test_md_done","overall_status":"passed","duration_s":0.5,"session_id":"s"}'\n`);
    chmodSync(bin, 0o755);
    const r = await new KaneCli(bin).replay({ testPath: 'a_test.md', identity: 'bob', cdpEndpoint: 'http://127.0.0.1:9302', cwd: dir });
    expect(r.run.status).toBe('passed');
    const args = readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(args.slice(0, 3)).toEqual(['testmd', 'run', 'a_test.md']);
    expect(args).toContain('--no-adaptive-heal');
    expect(args).toContain('--agent');
    expect(args[args.indexOf('--cdp-endpoint') + 1]).toBe('http://127.0.0.1:9302');
  });
});
