// Locating app folders: a folder whose .notyours/ holds a config or boundaries (e.g. demo/ in this repo, or the temp
// copy that `notyours demo` makes). Boundary surface globs are relative to it, not to the Claude Code project root.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../ratchet/store.js';
import { physicalOrUndefined } from './physical.js';

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A real app folder, not just any directory named .notyours: it must hold a config or boundaries. */
export function isAppDir(dir: string): boolean {
  const n = path.join(dir, '.notyours');
  return isDir(n) && ['config.yaml', 'boundaries.yaml', 'boundaries'].some((f) => existsSync(path.join(n, f)));
}

const inside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function enclosingApps(fileAbs: string, root: string): string[] {
  const out: string[] = [];
  let dir = path.dirname(fileAbs);
  if (!inside(root, dir)) return out;
  for (;;) {
    if (isAppDir(dir)) out.push(dir);
    if (dir === root) return out;
    dir = path.dirname(dir);
  }
}

export interface AppMatch {
  appDir: string;
  /** The edited file relative to appDir, POSIX separators. */
  rel: string;
}

/**
 * Every app folder that encloses `file`, for both the path as written and its physical (symlink-resolved) location,
 * searching no higher than `projectDir`. All enclosing apps are returned, not just the nearest, so a nested
 * .notyours/ cannot shadow an outer app's boundaries.
 */
export function appsForFile(file: string, projectDir: string): AppMatch[] {
  const root = path.resolve(projectDir);
  const lexical = path.resolve(root, file);
  const out = new Map<string, AppMatch>();
  const add = (abs: string, r: string) => {
    for (const appDir of enclosingApps(abs, r)) {
      const rel = path.relative(appDir, abs).split(path.sep).join('/');
      out.set(`${appDir}\0${rel}`, { appDir, rel });
    }
  };
  add(lexical, root);
  const physRoot = physicalOrUndefined(root);
  const phys = physicalOrUndefined(path.isAbsolute(file) ? file : `${root}/${file}`);
  if (phys && physRoot && phys !== lexical) add(phys, physRoot);
  return [...out.values()];
}

/** Back-compat helper: the nearest enclosing app folder. */
export function appDirForFile(file: string, projectDir: string): string | undefined {
  return appsForFile(file, projectDir)[0]?.appDir;
}

const SKIP = new Set(['node_modules', '.git']);

/** App folders at or below `projectDir` (breadth-first up to `maxDepth`; skips node_modules and .git only). */
export function scanAppDirs(projectDir: string, maxDepth = 6): string[] {
  const out: string[] = [];
  let level = [path.resolve(projectDir)];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (isAppDir(dir)) out.push(dir);
      if (depth === maxDepth) continue;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && !SKIP.has(e.name) && e.name !== '.notyours') next.push(path.join(dir, e.name));
      }
    }
    level = next;
  }
  return out;
}

/**
 * Index of app folders post-tool has marked dirty, so Stop can reach ones its scan would miss (deeper than the scan,
 * or reached through a symlink). It lives in the user's private cache dir ($XDG_CACHE_HOME or ~/.cache, mode 0700),
 * never in a shared temp dir another user could write, and is keyed by the project's physical path. On read, any
 * entry outside the project is dropped. If the index is lost, Stop still scans.
 */
function cacheDir(): string {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'notyours');
}

const ownedByMe = (p: string): boolean => {
  try {
    return typeof process.getuid !== 'function' || statSync(p).uid === process.getuid();
  } catch {
    return false;
  }
};

export function appIndexFile(projectDir: string): string {
  const key = physicalOrUndefined(path.resolve(projectDir)) ?? path.resolve(projectDir);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(cacheDir(), `apps-${hash}.json`);
}

function readIndex(projectDir: string): string[] {
  const file = appIndexFile(projectDir);
  if (!ownedByMe(path.dirname(file)) || !ownedByMe(file)) return [];
  const root = physicalOrUndefined(path.resolve(projectDir));
  if (!root) return [];
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => {
      if (typeof x !== 'string' || !path.isAbsolute(x)) return false;
      const phys = physicalOrUndefined(x);
      return phys !== undefined && inside(root, phys);
    });
  } catch {
    return [];
  }
}

export function rememberApp(projectDir: string, appDir: string): void {
  const known = readIndex(projectDir);
  if (known.includes(appDir)) return;
  const file = appIndexFile(projectDir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!ownedByMe(path.dirname(file))) return;
  writeJsonAtomic(file, [...known, appDir]);
}

/** Every app folder Stop should look at: the scan plus the index, de-duplicated by physical path. */
export function findAppDirs(projectDir: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...scanAppDirs(projectDir), ...readIndex(projectDir)]) {
    const key = physicalOrUndefined(d) ?? d;
    if (seen.has(key) || !isAppDir(d)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
