// A person approves the app's start command once, on this machine. config.yaml is committed and can come from a
// clone or an agent's shell, so `app.start` runs only when this machine's user has an approval for exactly this
// project (by its real path) with exactly this start command and port.
//
// The approval lives in the user's config folder (~/.config/notyours/app-approvals.json, mode 0600), NOT in the
// project: anything that can write inside the project (a clone, an agent's Edit) can't plant one. A file named
// app-approved.json inside .notyours/ is ignored. Both the CLI (`init`, `withApp`) and the Stop hook's app restart
// use this one check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The folder holding approvals. NOTYOURS_CONFIG_HOME overrides it (tests, CI); XDG_CONFIG_HOME is honoured too. */
export function approvalsDir(): string {
  if (process.env.NOTYOURS_CONFIG_HOME) return process.env.NOTYOURS_CONFIG_HOME;
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'notyours');
}

const approvalsFile = (): string => path.join(approvalsDir(), 'app-approvals.json');

interface ApprovalRecord { start: string; port: number; approvedAt: string }
type Store = Record<string, ApprovalRecord>;

/** The project's real path: a symlink can't point an approval at a different folder. */
export function projectKey(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(approvalsFile(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/** Records that the person approved running `start` on `port` for the project at `root`. */
export function approveStart(root: string, start: string, port: number): void {
  const dir = approvalsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = readStore();
  store[projectKey(root)] = { start, port, approvedAt: new Date().toISOString() };
  const file = approvalsFile();
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // mode applies only when the file is created
}

/** True only when exactly this start command and port were approved for this project on this machine. */
export function isAppStartApproved(root: string, start: string, port: number): boolean {
  const rec = readStore()[projectKey(root)];
  return !!rec && rec.start === start && rec.port === port;
}
