import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mockBoundary } from '../mocks/fixtures.js';
import { notyoursPaths } from '../ratchet/paths.js';
import { readDirty } from '../ratchet/store.js';
import { markSurfaceChanges, writeSurfaceBaseline } from './surface-scan.js';

const b = { ...mockBoundary, id: 'notes', surface: ['src/notes/**'], locked: true };
const other = { ...mockBoundary, id: 'billing', surface: ['src/billing.ts'], locked: true };

function project(git: boolean): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ny-scan-'));
  mkdirSync(path.join(d, '.notyours'), { recursive: true });
  mkdirSync(path.join(d, 'src/notes'), { recursive: true });
  writeFileSync(path.join(d, 'src/notes/route.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(d, 'src/billing.ts'), 'export const b = 1;\n');
  writeFileSync(path.join(d, 'README.md'), 'x\n');
  if (git) {
    const g = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  }
  return d;
}
/** An edit the way `sed -i` or a python script makes it: no Edit/Write tool, so no PostToolUse. */
function bashEdit(d: string, rel: string, text: string) {
  writeFileSync(path.join(d, rel), text);
  const t = new Date(Date.now() + 5000);
  utimesSync(path.join(d, rel), t, t); // make sure the mtime moves even on coarse filesystems
}

describe('surface scan (catch every edit)', () => {
  for (const git of [false, true]) {
    it(`${git ? 'git repo' : 'no git (mtime snapshot)'}: a Bash edit under a surface marks that boundary dirty, once`, () => {
      const d = project(git);
      writeSurfaceBaseline(d, [b, other]);
      expect(markSurfaceChanges(d, [b, other])).toEqual([]); // nothing changed since the baseline
      bashEdit(d, 'src/notes/route.ts', 'export const a = 2; // sed -i\n');
      bashEdit(d, 'README.md', 'not a surface\n');
      expect(markSurfaceChanges(d, [b, other])).toEqual(['notes']);
      const dirty = readDirty(notyoursPaths(d));
      expect(dirty.notes).toMatchObject({ files: ['src/notes/route.ts'], globs: ['src/notes/**'] });
      expect(dirty.billing).toBeUndefined();
      expect(markSurfaceChanges(d, [b, other])).toEqual([]); // the next pass doesn't re-mark it
      rmSync(path.join(d, 'src/billing.ts'));
      expect(markSurfaceChanges(d, [b, other])).toEqual(['billing']); // deletions count
      rmSync(d, { recursive: true, force: true });
    });
  }

  it('git repo with no snapshot yet: uncommitted surface changes (git status) count on the first pass', () => {
    const d = project(true);
    bashEdit(d, 'src/billing.ts', 'export const b = 2;\n');
    writeFileSync(path.join(d, 'src/notes/new.ts'), 'new\n'); // untracked
    expect(markSurfaceChanges(d, [b, other]).sort()).toEqual(['billing', 'notes']);
    rmSync(d, { recursive: true, force: true });
  });

  it('no git, no snapshot: the first pass is only the baseline', () => {
    const d = project(false);
    bashEdit(d, 'src/billing.ts', 'changed\n');
    expect(markSurfaceChanges(d, [b, other])).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
});
