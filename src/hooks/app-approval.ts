// A person approves the app's start command once, on this machine. config.yaml is committed and can come from a
// clone or an agent's shell, so `app.start` runs only when this machine's user has an approval for exactly this
// project (by its real path) with exactly this start command and port.
//
// The approval lives in the account's config folder (<passwd home>/.config/notyours/app-approvals.json, mode 0600),
// NOT in the project and NOT under any environment variable: HOME, XDG_CONFIG_HOME and NOTYOURS_* can't move it, so a
// command line or an agent's shell can't redirect it. Anything that can write inside the project can't plant one.
// The guard refuses agent writes to this folder. Both the CLI (`init`, `withApp`) and the Stop hook's app restart
// use this one check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testOverride: string | undefined;

/** Tests only: in-process, so nothing on the command line or in the environment can move the store. */
export function setApprovalsPathForTests(file: string | undefined): void {
  testOverride = file;
}

/** The account's home from the passwd database: unlike os.homedir() it ignores $HOME / $USERPROFILE. */
function accountHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

/** The folder that holds the approvals (the guard refuses agent writes here). */
export function approvalsDir(): string {
  return path.join(accountHome(), '.config', 'notyours');
}

const approvalsFile = (): string => testOverride ?? path.join(approvalsDir(), 'app-approvals.json');

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
  fs.mkdirSync(path.dirname(approvalsFile()), { recursive: true, mode: 0o700 });
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
