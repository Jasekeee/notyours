import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_COMMAND_MD } from './check-command.js';
import { MAP_COMMAND_MD } from '../map/command.js';
import { installHooks, guard } from './hooks.js';
import { GITIGNORE_LINES } from './commands.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ny-setup-'));

describe('notyours setup claude', () => {
  it('installs the hooks and both slash commands in one step, idempotently', () => {
    const root = tmp();
    const once = installHooks(root, 'notyours');
    const twice = installHooks(root, 'notyours');
    expect(fs.readFileSync(once.commandFile, 'utf8')).toBe(MAP_COMMAND_MD);
    expect(fs.readFileSync(once.checkFile, 'utf8')).toBe(CHECK_COMMAND_MD);
    expect(twice.checkFile).toBe(once.checkFile);
    const settings = JSON.parse(fs.readFileSync(once.settingsFile, 'utf8'));
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'Stop']);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('the /notyours-check command replays for 0 credits and never runs a paid command on its own', () => {
    expect(CHECK_COMMAND_MD).toMatch(/notyours\) replay|notyours replay/);
    expect(CHECK_COMMAND_MD).toMatch(/Do not run `run` or `lock --reauthor` without asking/);
  });

  it('the guard keeps the check command read-only for the coding agent, like /notyours-map', () => {
    const root = tmp();
    const r = guard({ tool_name: 'Edit', tool_input: { file_path: '.claude/commands/notyours-check.md' } }, root);
    expect(r.allow).toBe(false);
  });

  it('persona bookkeeping is gitignored with the other state', () => {
    expect(GITIGNORE_LINES).toContain('.notyours/personas.json');
  });
});
