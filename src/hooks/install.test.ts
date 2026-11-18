import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installHooks } from './install.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ny-install-'));
const read = (dir: string) => JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));

describe('installHooks', () => {
  it('creates .claude/settings.json with the three hooks and a long Stop timeout', () => {
    const dir = tmp();
    installHooks(dir);
    const s = read(dir);
    expect(s.hooks.PostToolUse).toEqual([{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'npx notyours hook post-tool', timeout: 10 }] }]);
    expect(s.hooks.PreToolUse).toEqual([{ matcher: 'Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: 'npx notyours hook guard', timeout: 10 }] }]);
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'npx notyours hook stop', timeout: 900 }] }]);
  });

  it('keeps existing settings and hooks, and re-running with another cliCommand replaces only ours', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, '.claude'));
    const existing = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/block-rm.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    };
    writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(existing));
    installHooks(dir);
    installHooks(dir, 'node /abs/path/dist/cli/index.js');
    const s = read(dir);
    expect(s.permissions).toEqual(existing.permissions);
    expect(s.hooks.PreToolUse).toEqual([
      existing.hooks.PreToolUse[0],
      { matcher: 'Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: 'node /abs/path/dist/cli/index.js hook guard', timeout: 10 }] },
    ]);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
    expect(JSON.stringify(s)).not.toContain('npx notyours');
  });

  it('refuses to overwrite invalid JSON', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'settings.json'), '{ nope');
    expect(() => installHooks(dir)).toThrow(/not valid JSON/);
    expect(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).toBe('{ nope');
  });
});
