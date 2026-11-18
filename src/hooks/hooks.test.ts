import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notyoursPaths } from '../ratchet/paths.js';
import { readDirty } from '../ratchet/store.js';
import { tempProject } from '../ratchet/testkit.js';
import { bashTouchesNotyours, GUARD_MESSAGE, runHook, type HookName } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string, project: string) =>
  readFileSync(path.join(here, 'fixtures', `${name}.json`), 'utf8').replaceAll('__PROJECT__', project);

let project: string;
beforeEach(() => {
  project = tempProject();
  vi.stubEnv('CLAUDE_PROJECT_DIR', ''); // the hooks must fall back to the fixture's cwd
});
afterEach(() => vi.unstubAllEnvs());

describe('post-tool hook', () => {
  it('marks a boundary dirty when its surface is edited, recording file and glob', async () => {
    const r = await runHook('post-tool', fixture('post-tool-edit-surface', project));
    expect(r.exitCode).toBe(0);
    const d = readDirty(notyoursPaths(project));
    expect(Object.keys(d)).toEqual(['notes-cross-user']);
    expect(d['notes-cross-user']).toMatchObject({ files: ['src/app/api/notes/route.ts'], globs: ['src/app/api/notes/**'] });
  });

  it('leaves dirty.json alone for unrelated files', async () => {
    const r = await runHook('post-tool', fixture('post-tool-write-unrelated', project));
    expect(r.exitCode).toBe(0);
    expect(readDirty(notyoursPaths(project))).toEqual({});
  });

  it('also matches .notyours/map.json entries (MultiEdit)', async () => {
    writeFileSync(notyoursPaths(project).map, JSON.stringify({ 'notes-cross-user': { files: ['lib/db/notes.ts'] }, ghost: ['lib/**'] }));
    const r = await runHook('post-tool', fixture('post-tool-multiedit-map', project));
    expect(r.exitCode).toBe(0);
    const d = readDirty(notyoursPaths(project));
    expect(Object.keys(d)).toEqual(['notes-cross-user']); // ids not in boundaries are ignored
    expect(d['notes-cross-user']?.globs).toEqual(['lib/db/notes.ts']);
  });

  it('accumulates files across edits without duplicates', async () => {
    await runHook('post-tool', fixture('post-tool-edit-surface', project));
    await runHook('post-tool', fixture('post-tool-edit-surface', project));
    expect(readDirty(notyoursPaths(project))['notes-cross-user']?.files).toEqual(['src/app/api/notes/route.ts']);
  });

  it('exits 0 on garbage input and on a broken boundary file', async () => {
    expect((await runHook('post-tool', 'not json')).exitCode).toBe(0);
    writeFileSync(notyoursPaths(project).boundariesFile, 'boundaries: [{id: BAD}]');
    expect((await runHook('post-tool', fixture('post-tool-edit-surface', project))).exitCode).toBe(0);
  });

  it('is fast: 200 boundaries, well under 300ms in-process', async () => {
    const many = Array.from({ length: 200 }, (_, n) => ({
      id: `b${n}`, kind: 'cross-user', owner: 'alice', viewer: 'bob',
      create: { objective: 'x', store: [] }, targets: { ui: ['/'], api: [] }, expect: 'denied',
      surface: [`src/mod${n}/**`, `lib/{a,b}${n}.ts`],
    }));
    project = tempProject(many as never);
    const t0 = performance.now();
    await runHook('post-tool', fixture('post-tool-edit-surface', project));
    expect(performance.now() - t0).toBeLessThan(300);
  });
});

describe('guard hook', () => {
  const blocked = ['guard-edit-boundaries', 'guard-write-test', 'guard-bash-rm-attempts', 'guard-bash-sed-config'];
  for (const name of blocked) {
    it(`blocks ${name} with exit 2 and the read-only message`, async () => {
      const r = await runHook('guard', fixture(name, project));
      expect(r.exitCode).toBe(2);
      expect(r.stderr?.trim()).toBe(GUARD_MESSAGE);
    });
  }
  it('blocks a different-case path (case-insensitive filesystems)', async () => {
    const r = await runHook('guard', JSON.stringify({ cwd: project, tool_name: 'Write', tool_input: { file_path: `${project}/.NotYours/attempts.json` } }));
    expect(r.exitCode).toBe(2);
  });

  it('blocks a write through a symlink that points into .notyours', async () => {
    symlinkSync(path.join(project, '.notyours'), path.join(project, 'innocent'));
    const r = await runHook('guard', JSON.stringify({ cwd: project, tool_name: 'Edit', tool_input: { file_path: `${project}/innocent/boundaries.yaml` } }));
    expect(r.exitCode).toBe(2);
  });

  it('blocks a write through a dangling symlink whose target is inside .notyours', async () => {
    symlinkSync(path.join(project, '.notyours', 'not-yet'), path.join(project, 'sneaky'));
    const r = await runHook('guard', JSON.stringify({ cwd: project, tool_name: 'Write', tool_input: { file_path: `${project}/sneaky/x.json` } }));
    expect(r.exitCode).toBe(2);
  });

  for (const name of ['guard-edit-app', 'guard-bash-npm-test']) {
    it(`allows ${name}`, async () => expect((await runHook('guard', fixture(name, project))).exitCode).toBe(0));
  }

  it.each([
    ['echo x > .notyours/dirty.json', true],
    ['cp /tmp/x.md .notyours/tests/a_test.md', true],
    ['cd .notyours && rm -rf tests', true],
    ['cat foo | tee .notyours/attempts.json', true],
    ['python3 -c "open(\'.notyours/attempts.json\',\'w\')"', true],
    ['find .notyours -name "*.json" -delete', true],
    ['cat $(echo .notyours/config.yaml)', true],
    ['npx notyours lock --reauthor notes-cross-user', true],
    ['git checkout -- .notyours/boundaries.yaml', true],
    ['ls .notyours/tests | xargs rm', true],
    ['cat .notyours/a && npm test', true],
    ['rm -rf .noty*/tests', true],
    ['rm -rf .n?tyours', true],
    ['rm .[n]otyours/attempts.json', true],
    ['echo {} > .NOTYOURS/dirty.json', true],
    ['rg --pre "rm -f" x .notyours', true],
    ['tree -o .notyours/attempts.json .', true],
    ['cat $D/.notyours/config.yaml', true],
    ["rm .not''yours/attempts.json", true],
    ['rm .noty\\ours/attempts.json', true],
    ['rm ".notyours"/attempts.json', true],
    ['rm .{n,x}otyours/attempts.json', true],
    ["find .notyours -'delete'", true],
    ['cat ".notyours/runs/a b.md"', false],
    ['rm -rf build/* dist/*', false],
    ['ls .git .github', false],
    ['cat .notyours/runs/last/report.md', false],
    ['ls -la .notyours/runs 2>&1 | head -20', false],
    ['grep -r NY-ALICE .notyours/runs > /dev/null', false],
    ['npx notyours replay notes-cross-user', false],
    ['vim src/notyours.ts', false],
    ['cat myapp.notyours.bak', false],
  ])('bash %s -> blocked=%s', (cmd, want) => expect(bashTouchesNotyours(cmd)).toBe(want));
});

describe('hook process (bin)', () => {
  const tsx = path.join(here, '..', '..', 'node_modules', '.bin', 'tsx');
  const bin = path.join(here, 'bin.ts');
  const run = (name: HookName, input: string) =>
    spawnSync(tsx, [bin, name], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: project } });

  it('guard exits 2 with the message on stderr', () => {
    const r = run('guard', fixture('guard-bash-rm-attempts', project));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(GUARD_MESSAGE);
  });

  it('stop exits 0 with no output when nothing is dirty', () => {
    const r = run('stop', fixture('stop-first', project));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('rejects an unknown hook name', () => {
    expect(() => execFileSync(tsx, [bin, 'nope'], { input: '{}', stdio: 'pipe' })).toThrow();
  });
});
