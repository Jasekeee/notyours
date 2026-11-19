import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withApp } from './commands.js';
import type { Config } from '../types.js';

const cfgFor = (baseUrl: string): Config => ({ baseUrl, allowHosts: ['localhost', '127.0.0.1'], parallel: true, liveCapture: true, creditFloor: 300, maxAttempts: 3 });

describe('withApp (run / lock --reauthor / replay)', () => {
  it('an app that already answers is used as is: nothing is started', async () => {
    const server = http.createServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-withapp-'));
    fs.mkdirSync(path.join(root, '.notyours'));
    fs.writeFileSync(path.join(root, '.notyours/config.yaml'), `baseUrl: http://127.0.0.1:${port}\napp:\n  start: "exit 1"\n  port: ${port}\n`);
    try {
      expect(await withApp(root, cfgFor(`http://127.0.0.1:${port}`), async () => 42)).toBe(42);
    } finally {
      server.close();
    }
  });

  it('no app.start and nothing answering: runs fn, and the engine reports the unreachable app', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-withapp-'));
    fs.mkdirSync(path.join(root, '.notyours'));
    fs.writeFileSync(path.join(root, '.notyours/config.yaml'), 'baseUrl: http://127.0.0.1:1\n');
    expect(await withApp(root, cfgFor('http://127.0.0.1:1'), async () => 'ran')).toBe('ran');
  });
});
