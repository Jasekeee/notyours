// Human confirmation of non-local hosts, stored OUTSIDE the project so a cloned repo (or the coding agent
// editing .notyours/config.yaml) cannot forge it. Written only by `notyours init --i-own-this`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Store = Record<string, string[]>; // realpath(project root) -> hosts

let testOverride: string | undefined;

/** Tests only: in-process, so nothing on the command line or in the environment can move the store. */
export function setOwnedStorePathForTests(file: string | undefined): void {
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

/** Fixed location: no environment variable (NOTYOURS_HOME, HOME, XDG_CONFIG_HOME) can move the store. */
export function ownedStorePath(): string {
  return testOverride ?? path.join(accountHome(), '.config', 'notyours', 'owned-hosts.json');
}

function key(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function read(file: string): Store {
  try {
    // Only trust a store that belongs to this user and that nobody else can write.
    const st = fs.lstatSync(file);
    if (!st.isFile() || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o022) !== 0) return {};
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Store) : {};
  } catch {
    return {};
  }
}

export function recordOwnedHosts(root: string, hosts: string[]): void {
  if (!hosts.length) return;
  const file = ownedStorePath();
  const store = read(file);
  const k = key(root);
  store[k] = [...new Set([...(store[k] ?? []), ...hosts.map((h) => h.toLowerCase())])].sort();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${file}`);
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function isOwnedHost(root: string, host: string): boolean {
  return (read(ownedStorePath())[key(root)] ?? []).includes(host.toLowerCase());
}
