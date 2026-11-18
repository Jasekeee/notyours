// One Chrome per identity, each with its own profile and CDP port.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Identity } from '../types.js';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LINUX_CHROMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/** Chrome executable: $NOTYOURS_CHROME, else the macOS app, else the first Linux candidate on PATH. */
export function chromePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NOTYOURS_CHROME) return env.NOTYOURS_CHROME;
  if (process.platform === 'darwin' && existsSync(MAC_CHROME)) return MAC_CHROME;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    for (const name of LINUX_CHROMES) {
      const p = join(dir, name);
      if (dir && existsSync(p)) return p;
    }
  }
  throw new Error('Chrome not found. Install Google Chrome or set NOTYOURS_CHROME to its executable path.');
}

export function cdpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function cdpUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${cdpEndpoint(port)}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ChromeHandle {
  identityId: string;
  port: number;
  endpoint: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  headful?: boolean;
  startupTimeoutMs?: number;
}

/** Launch Chrome for an identity and wait until its CDP endpoint answers. */
export async function launchChrome(identity: Identity, opts: LaunchOptions = {}): Promise<ChromeHandle> {
  const port = identity.cdpPort;
  if (await cdpUp(port)) {
    throw new Error(`Port ${port} (identity ${identity.id}) already has a CDP endpoint. Close that Chrome first.`);
  }
  mkdirSync(identity.userDataDir, { recursive: true });
  const headful = opts.headful ?? process.env.NOTYOURS_HEADFUL === '1';
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${identity.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--window-size=1440,900',
    ...(headful ? [] : ['--headless=new']),
    'about:blank',
  ];
  const child = spawn(chromePath(), args, { stdio: 'ignore' });
  let exited = false;
  child.once('exit', () => { exited = true; });

  const deadline = Date.now() + (opts.startupTimeoutMs ?? 20_000);
  while (!(await cdpUp(port))) {
    if (exited) throw new Error(`Chrome for ${identity.id} exited during startup (port ${port}).`);
    if (Date.now() > deadline) {
      await stop(child);
      throw new Error(`Chrome for ${identity.id} did not open CDP on port ${port} in time.`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { identityId: identity.id, port, endpoint: cdpEndpoint(port), close: () => stop(child) };
}

/** SIGTERM (lets Chrome flush cookies to the profile), then SIGKILL after 5s. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await done;
  clearTimeout(timer);
}

/** Lazily launches one Chrome per identity and closes them all at the end. */
export class ChromePool {
  private readonly handles = new Map<string, Promise<ChromeHandle>>();

  constructor(private readonly opts: LaunchOptions = {}) {}

  get(identity: Identity): Promise<ChromeHandle> {
    let h = this.handles.get(identity.id);
    if (!h) {
      h = launchChrome(identity, this.opts);
      h.catch(() => this.handles.delete(identity.id));
      this.handles.set(identity.id, h);
    }
    return h;
  }

  async close(identityId: string): Promise<void> {
    const h = this.handles.get(identityId);
    this.handles.delete(identityId);
    if (h) await (await h.catch(() => null))?.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.handles.keys()].map((id) => this.close(id)));
  }
}
