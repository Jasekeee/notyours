// The developer's app, for `notyours init`: is it answering, and if not, start it with app.start and wait.
import { spawn, type ChildProcess } from 'node:child_process';

export interface AppHandle {
  /** True when this process started the app (and must stop it when the wizard ends). */
  started: boolean;
  stop(): Promise<void>;
}

/** Any HTTP answer (even a 404 or a redirect) counts as up. A refused or timed-out connection does not. */
export async function isUp(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start `cmd` in `cwd` (PORT set to `port`) in its own process group, and wait until `url` answers. */
export async function startApp(cmd: string, cwd: string, port: number, url: string, timeoutMs = 60_000): Promise<AppHandle> {
  const child: ChildProcess = spawn('/bin/sh', ['-c', cmd], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port) },
  });
  let exited = false;
  child.once('exit', () => { exited = true; });
  const deadline = Date.now() + timeoutMs;
  while (!(await isUp(url))) {
    if (exited) throw new Error(`\`${cmd}\` exited before ${url} answered`);
    if (Date.now() > deadline) {
      await stopGroup(child);
      throw new Error(`\`${cmd}\` did not answer at ${url} within ${Math.round(timeoutMs / 1000)} s`);
    }
    await sleep(500);
  }
  return { started: true, stop: () => stopGroup(child) };
}

async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const done = new Promise<void>((r) => child.once('exit', () => r()));
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, 5_000);
  await Promise.race([done, sleep(7_000)]);
  clearTimeout(timer);
}
