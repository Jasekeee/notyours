// Human confirmation of non-local hosts, stored OUTSIDE the project so a cloned repo (or the coding agent
// editing .notyours/config.yaml) cannot forge it. Written only by `notyours init --i-own-this`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Store = Record<string, string[]>; // realpath(project root) -> hosts

export function ownedStorePath(env = process.env): string {
  return path.join(env.NOTYOURS_HOME ?? path.join(os.homedir(), '.config', 'notyours'), 'owned-hosts.json');
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
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Store) : {};
  } catch {
    return {};
  }
}

export function recordOwnedHosts(root: string, hosts: string[], env = process.env): void {
  if (!hosts.length) return;
  const file = ownedStorePath(env);
  const store = read(file);
  const k = key(root);
  store[k] = [...new Set([...(store[k] ?? []), ...hosts.map((h) => h.toLowerCase())])].sort();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function isOwnedHost(root: string, host: string, env = process.env): boolean {
  return (read(ownedStorePath(env))[key(root)] ?? []).includes(host.toLowerCase());
}
