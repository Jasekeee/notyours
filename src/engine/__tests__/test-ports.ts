// Test helpers for Chrome-launching tests: free ports (parallel files must never share a CDP port) and a
// kill-by-profile-path fallback for Chrome that a subprocess (the CLI under test) started.
import { execFileSync } from 'node:child_process';
import net from 'node:net';

/** True when nothing is listening on 127.0.0.1:port and we can bind it. */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

// Below the OS ephemeral ranges (macOS 49152+, Linux 32768+). A port-0 probe lands in the ephemeral range, where
// outgoing connections from parallel tests (fetch, CDP websockets) can take the port before Chrome binds it.
const RANGE_LO = 20_000;
const RANGE_HI = 32_000;

/** The first of `n` consecutive free ports on 127.0.0.1 (identity i gets base + i). */
export async function freePortRange(n: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const base = RANGE_LO + Math.floor(Math.random() * (RANGE_HI - RANGE_LO - n));
    const free = await Promise.all(Array.from({ length: n }, (_, i) => canBind(base + i)));
    if (free.every(Boolean)) return base;
  }
  throw new Error(`no ${n} consecutive free ports found in ${RANGE_LO}-${RANGE_HI}`);
}

/**
 * SIGKILL every process whose command line contains `pattern` (a temp-dir prefix such as the test's
 * mkdtemp path). Used after a test file, so Chrome started by a subprocess cannot outlive the file.
 * `pkill` exits 1 when nothing matched; that is fine.
 */
export function killChromesUsing(pattern: string): void {
  if (!/^[\w./-]+$/.test(pattern)) throw new Error(`unsafe pkill pattern: ${pattern}`);
  try {
    execFileSync('pkill', ['-KILL', '-f', pattern], { stdio: 'ignore' });
  } catch {
    /* nothing matched, or pkill is missing: the in-process kill (killLiveChromes) still ran */
  }
}
