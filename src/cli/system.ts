// Thin wrappers around the machine: kane-cli, Chrome, ports, opening files. Injectable for tests.
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { execa } from 'execa';

export interface ExecResult {
  /** undefined when the binary could not be started (e.g. ENOENT). */
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  notFound: boolean;
}

export type Exec = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

export const exec: Exec = async (file, args, opts = {}) => {
  const r = await execa(file, args, { reject: false, timeout: opts.timeoutMs ?? 30_000, env: { NO_COLOR: '1', FORCE_COLOR: '0' } });
  return {
    exitCode: r.exitCode,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    notFound: r.code === 'ENOENT',
  };
};

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

// ---------- kane-cli ----------

export type KaneAuth = { state: 'ok' } | { state: 'missing' } | { state: 'unauthenticated'; detail: string };

/** `kane-cli --version` as x.y.z, or undefined when kane-cli is missing or prints something else. */
export async function kaneVersion(run: Exec = exec): Promise<string | undefined> {
  try {
    const r = await run('kane-cli', ['--version'], { timeoutMs: 30_000 });
    const m = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}`.trim().split('\n').at(-1) ?? '');
    return m?.[1];
  } catch {
    return undefined;
  }
}

export async function kaneWhoami(run: Exec = exec): Promise<KaneAuth> {
  const r = await run('kane-cli', ['whoami']);
  if (r.notFound) return { state: 'missing' };
  const out = stripAnsi(`${r.stdout}\n${r.stderr}`);
  if (r.exitCode === 0 && /✓\s*Authenticated|\bAuthenticated\b/.test(out) && !/not authenticated|not logged in/i.test(out)) return { state: 'ok' };
  return { state: 'unauthenticated', detail: 'run `kane-cli login`' };
}

/** Parses "Available credits: 11121.83". undefined if kane-cli is missing or the output is unrecognised. */
export async function kaneBalance(run: Exec = exec): Promise<number | undefined> {
  const r = await run('kane-cli', ['balance']);
  if (r.notFound || r.exitCode !== 0) return undefined;
  const m = /Available credits:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(stripAnsi(r.stdout));
  return m ? Number(m[1]) : undefined;
}

// ---------- Chrome ----------

export function chromeCandidates(platform = process.platform, env = process.env): string[] {
  const list: string[] = [];
  if (env.CHROME_PATH) list.push(env.CHROME_PATH);
  if (platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      `${env.HOME ?? ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    );
  } else if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (base) list.push(`${base}\\Google\\Chrome\\Application\\chrome.exe`);
    }
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  return list;
}

export function findChrome(exists: (p: string) => boolean = fs.existsSync): string | undefined {
  return chromeCandidates().find((p) => p && exists(p));
}

// ---------- ports ----------

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** Poll until something answers HTTP on url (any status), or time out. */
export async function waitForHttp(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

// ---------- open ----------

export function openFile(target: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [target]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : ['xdg-open', [target]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}
