import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { notyoursPaths } from '../ratchet/paths.js';
import type { Boundary } from '../types.js';
import { lockedBoundary } from '../ratchet/testkit.js';
import { writeConfig } from '../cli/workspace.js';
import { approveStart } from '../cli/app-approval.js';
import {
  appPort, checkAppFreshness, listenersOn, parseEtime, readAppSettings, restartApp, STALE_MESSAGE, waitForPort, type FreshnessDeps,
} from './app-freshness.js';

const project = (config: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ny-fresh-'));
  mkdirSync(path.join(dir, '.notyours'), { recursive: true });
  writeFileSync(path.join(dir, '.notyours', 'config.yaml'), config);
  return dir;
};
const b: Boundary = { ...lockedBoundary, surface: ['server.js'] };
const deps = (over: Partial<FreshnessDeps>): FreshnessDeps => ({
  listeners: () => [], ageSeconds: () => undefined, now: () => Date.now(), restart: async () => undefined, answers: async () => true, ...over,
});

describe('app settings', () => {
  it('reads app.start / app.port next to the frozen config fields, and ignores an invalid block', () => {
    const p = notyoursPaths(project('baseUrl: http://localhost:4001\napp:\n  start: PORT=4001 node server.js\n  port: 4001\n'));
    expect(readAppSettings(p)).toEqual({ start: 'PORT=4001 node server.js', port: 4001 });
    expect(readAppSettings(notyoursPaths(project('baseUrl: http://localhost:4001\napp:\n  port: nope\n')))).toEqual({});
    expect(readAppSettings(notyoursPaths(project('baseUrl: http://localhost:4001\n')))).toEqual({});
  });

  it('app port defaults to the baseUrl port', () => {
    expect(appPort({}, 'http://127.0.0.1:3077')).toBe(3077);
    expect(appPort({}, 'https://localhost')).toBe(443);
    expect(appPort({ port: 5000 }, 'http://127.0.0.1:3077')).toBe(5000);
  });

  it('init (writeConfig) keeps an existing app block', () => {
    const dir = project('baseUrl: http://localhost:4001\napp:\n  start: node server.js\n');
    writeConfig(dir, { baseUrl: 'http://localhost:4001', allowHosts: ['localhost'] });
    expect(readAppSettings(notyoursPaths(dir))).toEqual({ start: 'node server.js' });
  });

  it('parses ps etime', () => {
    expect(parseEtime('  05:07')).toBe(307);
    expect(parseEtime('01:02:03')).toBe(3723);
    expect(parseEtime('2-01:02:03')).toBe(2 * 86400 + 3723);
    expect(parseEtime('garbage')).toBeUndefined();
  });
});

describe('checkAppFreshness', () => {
  const withServerJs = (config = 'baseUrl: http://127.0.0.1:4001\n') => {
    const dir = project(config);
    writeFileSync(path.join(dir, 'server.js'), '// edited now\n');
    return dir;
  };

  it('server started before the newest surface file: stale (YELLOW message, no replay)', async () => {
    const dir = withServerJs();
    const r = await checkAppFreshness(dir, notyoursPaths(dir), 'http://127.0.0.1:4001', [b], deps({ listeners: () => [77], ageSeconds: () => 600 }));
    expect(r.status).toBe('stale');
    if (r.status === 'stale') expect(r.message).toContain(STALE_MESSAGE);
  });

  it('server started after the edit: fresh', async () => {
    const dir = withServerJs();
    const r = await checkAppFreshness(dir, notyoursPaths(dir), 'http://127.0.0.1:4001', [b], deps({ listeners: () => [77], ageSeconds: () => 0, now: () => Date.now() + 60_000 }));
    expect(r.status).toBe('fresh');
  });

  it("can't verify the server is current -> YELLOW, never a replay as if fresh (audit P1-08)", async () => {
    const dir = withServerJs();
    const check = (over: Partial<FreshnessDeps>) => checkAppFreshness(dir, notyoursPaths(dir), 'http://127.0.0.1:4001', [b], deps(over));
    const yellow = { status: 'unverified', message: expect.stringContaining("can't verify the server is current") };
    // no lsof
    expect(await check({ listeners: () => undefined })).toMatchObject(yellow);
    // the port answers, but lsof sees no listener (another user's process, a container's proxy)
    expect(await check({ listeners: () => [], answers: async () => true })).toMatchObject(yellow);
    // a listener whose start time can't be read
    expect(await check({ listeners: () => [77], ageSeconds: () => undefined })).toMatchObject(yellow);
    // nothing answers at all: say so before any Kane run
    expect(await check({ listeners: () => [], answers: async () => false })).toMatchObject({ status: 'unverified', message: expect.stringContaining('nothing answers on :4001') });
  });

  it('app.start set but not approved here: YELLOW with the approve command, and no restart', async () => {
    const dir = withServerJs('baseUrl: http://127.0.0.1:4001\napp:\n  start: node server.js\n');
    const calls: unknown[][] = [];
    const r = await checkAppFreshness(dir, notyoursPaths(dir), 'http://127.0.0.1:4001', [b], deps({ restart: async (...a) => { calls.push(a); } }));
    expect(r).toMatchObject({ status: 'unapproved', message: expect.stringContaining('YELLOW') });
    expect(r.status === 'unapproved' && r.message).toContain('npx notyours init');
    expect(calls).toEqual([]);
  });

  it('an approval for another command or port does not count', async () => {
    const dir = withServerJs('baseUrl: http://127.0.0.1:4001\napp:\n  start: node server.js\n');
    approveStart(dir, 'node other.js', 4001);
    approveStart(dir, 'node server.js', 4002);
    const r = await checkAppFreshness(dir, notyoursPaths(dir), 'http://127.0.0.1:4001', [b], deps({ restart: async () => { throw new Error('must not run'); } }));
    expect(r.status).toBe('unapproved');
  });

  it('app.start approved for this command and port: restarts (and reports a failed restart as YELLOW)', async () => {
    const dir = withServerJs('baseUrl: http://127.0.0.1:4001\napp:\n  start: node server.js\n');
    approveStart(dir, 'node server.js', 4001);
    const calls: unknown[][] = [];
    const ok = await checkAppFreshness(dir, notyoursPaths(dir), 'http://127.0.0.1:4001', [b], deps({ restart: async (...a) => { calls.push(a); } }));
    expect(ok.status).toBe('restarted');
    expect(calls[0]?.slice(0, 4)).toEqual([dir, 'node server.js', 4001, '127.0.0.1']);
    const bad = await checkAppFreshness(dir, notyoursPaths(dir), 'http://127.0.0.1:4001', [b], deps({ restart: async () => { throw new Error('port never answered'); } }));
    expect(bad).toMatchObject({ status: 'restart-failed', message: expect.stringContaining('port never answered') });
  });
});

describe('restartApp (real processes)', () => {
  const started: number[] = [];
  afterEach(() => { for (const pid of started.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  const freePort = () => new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });

  it('stops the old server on the port, starts app.start, and waits until the port answers', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ny-restart-'));
    const port = await freePort();
    writeFileSync(path.join(dir, 'server.js'), `require('http').createServer((q, s) => s.end(String(process.pid))).listen(${port}, '127.0.0.1');\n`);
    const log = path.join(dir, 'app.log');
    await restartApp(dir, 'node server.js', port, '127.0.0.1', log, 10_000);
    const first = listenersOn(port) ?? [];
    started.push(...first);
    expect(first.length).toBe(1);
    await restartApp(dir, 'node server.js', port, '127.0.0.1', log, 10_000);
    const second = listenersOn(port) ?? [];
    started.push(...second);
    expect(second.length).toBe(1);
    expect(second[0]).not.toBe(first[0]); // a new process
  }, 30_000);

  // A separate "old server" process (never this test worker: the old code would SIGTERM whatever lsof shows).
  const oldServer = async (port: number) => {
    const child = spawn(process.execPath, ['-e', `require('net').createServer((c) => { c.on('error', () => {}); c.end('OLD'); }).listen(${port}, '127.0.0.1')`], { stdio: 'ignore' });
    started.push(child.pid!);
    await waitForPort('127.0.0.1', port, 5_000);
    return child;
  };
  const answer = (port: number) => new Promise<string>((r) => { const c = net.connect(port, '127.0.0.1'); let d = ''; c.on('data', (x) => (d += x)); c.on('close', () => r(d)); c.on('error', () => r('')); });

  it("audit P0-3: without lsof, an old server it can't stop is never reported as restarted; the old one keeps the port", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ny-restart-'));
    const port = await freePort();
    await oldServer(port);
    writeFileSync(path.join(dir, 'server.js'), `require('net').createServer((c) => { c.on('error', () => {}); c.end('NEW'); }).listen(${port}, '127.0.0.1');\n`);
    const savedPath = process.env.PATH;
    process.env.PATH = path.dirname(process.execPath); // node only: no lsof
    try {
      await expect(restartApp(dir, `"${process.execPath}" server.js`, port, '127.0.0.1', path.join(dir, 'app.log'), 5_000, { stopWaitMs: 300 }))
        .rejects.toThrow(/still answers/);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(await answer(port)).toBe('OLD');
  }, 20_000);

  it('audit P0-3: lsof sees no listener, but the port still answers (another user, a container proxy): refused', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ny-restart-'));
    const port = await freePort();
    await oldServer(port);
    await expect(restartApp(dir, 'node server.js', port, '127.0.0.1', path.join(dir, 'app.log'), 5_000, { listeners: () => [], stopWaitMs: 300 }))
      .rejects.toThrow(/still answers/);
    expect(await answer(port)).toBe('OLD');
  }, 20_000);

  it('audit P0-3: after starting, the port must be held by a NEW listener, not one that was there before', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ny-restart-'));
    const port = await freePort();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' }); // a harmless "old pid" that lsof keeps reporting
    started.push(sleeper.pid!);
    writeFileSync(path.join(dir, 'server.js'), `require('net').createServer((c) => { c.on('error', () => {}); c.end('NEW'); }).listen(${port}, '127.0.0.1');\n`);
    try {
      await expect(restartApp(dir, 'node server.js', port, '127.0.0.1', path.join(dir, 'app.log'), 5_000, { listeners: () => [sleeper.pid!], stopWaitMs: 300 }))
        .rejects.toThrow(/not a new process/);
    } finally {
      started.push(...(listenersOn(port) ?? []));
    }
  }, 20_000);

  it('a start command that dies is reported with the end of its log', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ny-restart-'));
    const port = await freePort();
    await expect(restartApp(dir, "echo 'boom: cannot start' >&2; exit 3", port, '127.0.0.1', path.join(dir, 'app.log'), 5_000))
      .rejects.toThrow(/exited \(code 3\)[\s\S]*boom: cannot start/);
  }, 15_000);
});
