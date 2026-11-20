import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Boundary, Identity } from '../types.js';
import { mockBoundary, mockIdentities } from '../mocks/fixtures.js';
import { boundaryRuns, estimateAuthoring, estimateLine } from './estimate.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ny-est-'));
const ids = (dir: string): Identity[] => mockIdentities.map((i) => ({ ...i, userDataDir: path.join(dir, 'profiles', i.id) }));

describe('authoring estimate (audit P1-11: logins counted, a range printed)', () => {
  it('counts the Kane runs each boundary kind starts', () => {
    expect(boundaryRuns(mockBoundary)).toBe(3); // owner create, viewer create, viewer visit
    expect(boundaryRuns({ ...mockBoundary, viewerOwn: { ui: ['http://127.0.0.1:3000/notes/2'], api: [] } })).toBe(2);
    expect(boundaryRuns({ ...mockBoundary, kind: 'guest', viewer: 'guest' })).toBe(2);
    const gate: Boundary = { ...mockBoundary, kind: 'plan-gate', viewer: 'bob', proAction: { objective: 'export' } };
    expect(boundaryRuns(gate)).toBe(5);
    expect(boundaryRuns({ ...mockBoundary, targets: { ui: [], api: ['POST http://127.0.0.1:3000/api/x'] } })).toBe(2);
  });

  it('adds one run per persona whose login is not recorded yet, and none for guests', () => {
    const dir = tmp();
    const e = estimateAuthoring([mockBoundary], ids(dir), dir);
    expect(e.logins).toEqual(['alice', 'bob']);
    expect(e.runs).toBe(5);
    expect([e.low, e.high]).toEqual([50, 100]);
    expect(estimateLine(e)).toBe('about 50–100 Kane credits: 5 authoring runs (2 logins to record (alice, bob) + 3 for 1 boundary), 10–20 each on kane-cli 0.10.0');

    const guest = estimateAuthoring([{ ...mockBoundary, kind: 'guest', viewer: 'guest' }], ids(dir), dir);
    expect(guest.logins).toEqual(['alice']);
  });

  it('a recorded login (in the profile or in .notyours/tests) is replayed, not counted', () => {
    const dir = tmp();
    const list = ids(dir);
    fs.mkdirSync(path.join(list[0]!.userDataDir, 'notyours-login'), { recursive: true });
    fs.writeFileSync(path.join(list[0]!.userDataDir, 'notyours-login', 'login_alice_test.md'), '');
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests', 'login_bob_test.md'), '');
    const e = estimateAuthoring([mockBoundary], list, dir);
    expect(e.logins).toEqual([]);
    expect(e.runs).toBe(3);
    expect(estimateLine(e)).toBe('about 30–60 Kane credits: 3 authoring runs (3 for 1 boundary), 10–20 each on kane-cli 0.10.0');
  });
});
