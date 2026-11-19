import { describe, expect, it } from 'vitest';
import { nextStep, renderStatus, type StatusReport } from './status.js';
import type { Boundary } from '../types.js';

type Base = Omit<StatusReport, 'next'>;
const base = (over: Partial<Base> = {}): Base => ({
  root: '/app',
  configured: true,
  baseUrl: 'http://localhost:4000',
  personas: { ids: ['alice', 'bob', 'guest'], withLogin: ['alice', 'bob', 'guest'], missingLogin: [] },
  boundaries: { total: 0, ids: [], locked: [], drafts: [] },
  hooks: { installed: true },
  protectedForAgent: ['secrets and browser profiles'],
  ...over,
});
const b = (id: string, locked = false): Boundary =>
  ({ id, kind: 'cross-user', owner: 'alice', viewer: 'bob', create: { objective: 'x', store: [] }, targets: { ui: [], api: [] }, expect: 'denied', surface: [], ...(locked ? { locked: true } : {}) }) as Boundary;

describe('bare `notyours`: the single next command', () => {
  it('walks the steps in order: init, map, /notyours-map, run, lock, hooks, replay', () => {
    expect(nextStep(base({ configured: false }), []).command).toBe('notyours init');
    expect(nextStep(base(), []).command).toBe('notyours map');
    expect(nextStep(base({ boundaries: { total: 0, ids: [], locked: [], drafts: ['notes-cross-user'] } }), []).command).toBe('/notyours-map (in Claude Code)');
    expect(nextStep(base({ boundaries: { total: 1, ids: ['a'], locked: [], drafts: [] } }), [b('a')]).command).toBe('notyours run --dry-run');
    expect(nextStep(base({ boundaries: { total: 1, ids: ['a'], locked: [], drafts: [] }, lastRun: { verdicts: { a: 'HELD' }, leaks: [] } }), [b('a')]).command).toBe('notyours lock');
    expect(nextStep(base({ boundaries: { total: 1, ids: ['a'], locked: ['a'], drafts: [] }, lastRun: { verdicts: { a: 'HELD' }, leaks: [] }, hooks: { installed: false } }), [b('a', true)]).command).toBe('notyours setup claude');
    expect(nextStep(base({ boundaries: { total: 1, ids: ['a'], locked: ['a'], drafts: [] }, lastRun: { verdicts: { a: 'HELD' }, leaks: [] } }), [b('a', true)]).command).toBe('notyours replay');
  });

  it('a leak comes before anything else: show the report, then replay after the fix', () => {
    const n = nextStep(base({ boundaries: { total: 1, ids: ['a'], locked: [], drafts: [] }, lastRun: { verdicts: { a: 'LEAK_VISIBLE' }, leaks: ['a'] } }), [b('a')]);
    expect(n.command).toBe('notyours report --open');
    expect(n.why).toMatch(/1 leak\(s\): a/);
  });

  it('personas without a login send you back to init', () => {
    expect(nextStep(base({ personas: { ids: ['alice'], withLogin: [], missingLogin: ['alice'] } }), []).command).toBe('notyours init');
  });

  it('renders configured state, what is protected, and the Next line', () => {
    const text = renderStatus({ ...base({ boundaries: { total: 0, ids: [], locked: [], drafts: ['x'] } }), next: { command: '/notyours-map (in Claude Code)', why: '1 draft' } });
    expect(text).toMatch(/app http:\/\/localhost:4000/);
    expect(text).toMatch(/drafts 1/);
    expect(text).toMatch(/locked for the coding agent: secrets and browser profiles/);
    expect(text).toMatch(/Next: \/notyours-map \(in Claude Code\)/);
  });
});
