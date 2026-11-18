// Locating the app folder: the folder that contains .notyours/ (e.g. demo/ in this repo, or the temp copy that
// `notyours demo` makes). Boundary surface globs are relative to it, not to the Claude Code project root.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const hasNotyours = (dir: string): boolean => isDir(path.join(dir, '.notyours'));

const inside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The nearest ancestor of `file` that contains .notyours/, searching no higher than `projectDir`.
 * Undefined when the file is outside the project or no app folder encloses it.
 */
export function appDirForFile(file: string, projectDir: string): string | undefined {
  const root = path.resolve(projectDir);
  let dir = path.dirname(path.resolve(root, file));
  if (!inside(root, dir)) return undefined;
  for (;;) {
    if (hasNotyours(dir)) return dir;
    if (dir === root) return undefined;
    dir = path.dirname(dir);
  }
}

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage']);

/** App folders at or below `projectDir` (breadth-first, up to `maxDepth` levels, skipping dot/vendor dirs). */
export function findAppDirs(projectDir: string, maxDepth = 3): string[] {
  const out: string[] = [];
  let level = [path.resolve(projectDir)];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (hasNotyours(dir)) out.push(dir);
      if (depth === maxDepth) continue;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) next.push(path.join(dir, e.name));
      }
    }
    level = next;
  }
  return out;
}
