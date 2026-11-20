// The hooks must fail CLOSED: a missing or broken notyours CLI blocks (exit 2), it never silently passes.
// These run the real launcher command and script under /bin/sh.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_UNAVAILABLE, HOOK_WRAPPER, PINNED_NPX, hookLauncherCommand, hookLauncherScript, selfCliPath, shq, type LaunchedHook } from './hook-launcher.js';
import pkg from '../../package.json' with { type: 'json' };
import { guard, installHooks } from './hooks.js';
import { checkHooks } from './doctor.js';

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ny-launch-'));
// No node, no notyours, no npx on PATH: nothing to fall back to.
const bareEnv = (root: string) => ({ PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: root, NOTYOURS_HOOK_NO_NPX: '1' });
const settingsCommand = (root: string, event: LaunchedHook): string => {
  const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  const ev = { guard: 'PreToolUse', 'post-tool': 'PostToolUse', stop: 'Stop' }[event];
  return s.hooks[ev].at(-1).hooks[0].command;
};
const runHook = (root: string, cmd: string, input: object, env: Record<string, string> = bareEnv(root)) =>
  spawnSync('/bin/sh', ['-c', cmd], { cwd: root, env, input: JSON.stringify(input), encoding: 'utf8' });
const toolCall = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };

describe('fail-closed hook launcher', () => {
  it('missing CLI → every hook exits 2 with the "guard unavailable" message', () => {
    const root = project();
    installHooks(root, undefined, path.join(root, 'gone', 'dist', 'cli', 'index.js')); // the CLI it was installed from is gone
    for (const event of ['guard', 'post-tool', 'stop'] as const) {
      const r = runHook(root, settingsCommand(root, event), { ...toolCall, stop_hook_active: false });
      expect(r.status, event).toBe(2);
      expect(r.stderr).toContain(HOOK_UNAVAILABLE);
      expect(r.stderr).toContain('no notyours CLI found');
    }
  });

  it('missing launcher (e.g. .notyours/bin deleted) → still exits 2 with the message', () => {
    const root = project();
    for (const event of ['guard', 'post-tool', 'stop'] as const) {
      const r = runHook(root, hookLauncherCommand(event), toolCall);
      expect(r.status, event).toBe(2);
      expect(r.stderr).toContain(HOOK_UNAVAILABLE);
    }
  });

  it('a crashing CLI (exit 1) blocks too, instead of passing', () => {
    const root = project();
    installHooks(root, "sh -c 'cat >/dev/null; echo boom >&2; exit 1' x");
    const r = runHook(root, settingsCommand(root, 'guard'), toolCall);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('failed with exit 1');
  });

  it("keeps Stop's loop protection: with stop_hook_active the unavailable note is shown but the stop goes through", () => {
    const root = project();
    expect(runHook(root, hookLauncherCommand('stop'), { stop_hook_active: true }).status).toBe(0); // no launcher
    installHooks(root, undefined, '/nonexistent/index.js');
    const r = runHook(root, settingsCommand(root, 'stop'), { hook_event_name: 'Stop', stop_hook_active: true });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(HOOK_UNAVAILABLE);
    // Not on the first stop: that one blocks.
    expect(runHook(root, settingsCommand(root, 'stop'), { hook_event_name: 'Stop', stop_hook_active: false }).status).toBe(2);
  });

  it('a working CLI gets the hook input on stdin, and its stdout and exit code (0 or 2) pass through', () => {
    const root = project();
    installHooks(root, "sh -c 'cat; exit 0' x");
    const ok = runHook(root, settingsCommand(root, 'guard'), toolCall);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual(toolCall);
    installHooks(root, "sh -c 'cat >/dev/null; echo leak >&2; exit 2' x");
    const block = runHook(root, settingsCommand(root, 'stop'), { stop_hook_active: false });
    expect(block.status).toBe(2);
    expect(block.stderr).toContain('leak');
    expect(block.stderr).not.toContain(HOOK_UNAVAILABLE);
  });

  it("prefers the project's own node_modules/.bin/notyours over the install-time path", () => {
    const root = project();
    const bin = path.join(root, 'node_modules', '.bin', 'notyours');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\necho "local $1 $2"\n', { mode: 0o755 });
    installHooks(root, undefined, '/nonexistent/index.js');
    const r = runHook(root, settingsCommand(root, 'guard'), toolCall);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('local hook guard');
  });

  it('installs the launcher executable and never writes a CLI path into settings.json', () => {
    const root = project();
    installHooks(root, undefined, '/somewhere/npx-cache/notyours/dist/cli/index.js');
    expect(fs.statSync(path.join(root, HOOK_WRAPPER)).mode & 0o111).not.toBe(0);
    const settings = fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8');
    expect(settings).not.toContain('npx-cache');
    expect(settings).toContain(HOOK_WRAPPER);
  });

  it('the guard keeps the launcher read-only for the agent (Edit, Write and Bash)', () => {
    const root = project();
    installHooks(root);
    const f = path.join(root, HOOK_WRAPPER);
    expect(guard({ tool_name: 'Edit', tool_input: { file_path: f } }, root).allow).toBe(false);
    expect(guard({ tool_name: 'Write', tool_input: { file_path: f } }, root).allow).toBe(false);
    expect(guard({ tool_name: 'Bash', tool_input: { command: `rm ${HOOK_WRAPPER}` } }, root).allow).toBe(false);
    expect(guard({ tool_name: 'Bash', tool_input: { command: `echo 'exit 0' > ${HOOK_WRAPPER}` } }, root).allow).toBe(false);
  });

  it('selfCliPath: a built .js CLI by real path, nothing for tsx/dev', () => {
    const f = path.join(project(), "it's", 'index.js');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
    expect(selfCliPath(f)).toBe(fs.realpathSync(f));
    expect(selfCliPath('/src/cli/index.ts')).toBeUndefined();
    expect(selfCliPath('')).toBeUndefined();
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });
});

describe('doctor: installed hook commands resolve', () => {
  it('ok when the launcher finds a CLI; FIX line when it does not or when hooks are old-style', () => {
    const root = project();
    expect(checkHooks(root)).toBeUndefined(); // no hooks installed: nothing to check
    installHooks(root, "sh -c 'exit 0' x");
    expect(checkHooks(root)).toMatchObject({ status: 'ok', detail: expect.stringContaining('3 hooks →') });

    fs.rmSync(path.join(root, HOOK_WRAPPER));
    expect(checkHooks(root)).toMatchObject({ status: 'fail', detail: expect.stringContaining('FIX: npx notyours install-hooks') });

    installHooks(root, undefined, '/nonexistent/index.js');
    const none = checkHooks(root, (l) => spawnSync('/bin/sh', [l, '--resolve'], { encoding: 'utf8', env: bareEnv(root) }));
    expect(none).toMatchObject({ status: 'fail', detail: expect.stringMatching(/no notyours CLI found.*FIX:/) });

    const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    s.hooks.PreToolUse.at(-1).hooks[0].command = "node '/old/dist/cli/index.js' hook guard";
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(s));
    expect(checkHooks(root)).toMatchObject({ status: 'fail', detail: expect.stringContaining('fail open') });
  });

  it('the npx fallback runs the installed version from npm, never GitHub (audit P1-02)', () => {
    expect(PINNED_NPX).toBe(`npx --yes notyours@${pkg.version}`);
    const script = hookLauncherScript({});
    expect(script).toContain(`${PINNED_NPX} hook "$event"`);
    expect(script).not.toContain('github:');
    expect(HOOK_UNAVAILABLE).toContain('npx notyours install-hooks');
  });
});
