// Kernel-style path resolution shared by the hooks (guard, post-tool, stop).
import { lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';

export class Unresolvable extends Error {}
const MAX_LINKS = 40; // macOS gives up at 32 links, Linux at 40

/**
 * Where the kernel would put `p`, walked one component at a time the way path lookup works: `..` applies to the
 * physical directory reached so far (never to the raw string, which path.resolve/join would do), and every symlink,
 * dangling ones included, is spliced into the remaining components. Components that don't exist yet are taken as
 * plain directories, since Write creates missing parents. Throws Unresolvable on a loop; callers fail closed.
 */
export function physicalPath(p: string): string {
  if (!path.isAbsolute(p)) throw new Unresolvable(p);
  const todo = p.split(/[\\/]+/).filter(Boolean);
  let cur = path.parse(p).root || '/';
  let links = 0;
  let missing = false; // once a component is missing, nothing below it exists either
  while (todo.length) {
    const c = todo.shift() as string;
    if (c === '.') continue;
    if (c === '..') {
      cur = path.dirname(cur);
      missing = false;
      continue;
    }
    const next = path.join(cur, c);
    if (missing) {
      cur = next;
      continue;
    }
    let st: import('node:fs').Stats;
    try {
      st = lstatSync(next);
    } catch {
      missing = true;
      cur = next;
      continue;
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (++links > MAX_LINKS) throw new Unresolvable(p);
    const target = readlinkSync(next);
    if (path.isAbsolute(target)) cur = path.parse(target).root || '/';
    todo.unshift(...target.split(/[\\/]+/).filter(Boolean)); // relative targets resolve from cur (the link's physical parent)
  }
  return cur;
}

/** physicalPath, or undefined when it can't be resolved (loops). */
export function physicalOrUndefined(p: string): string | undefined {
  try {
    return physicalPath(p);
  } catch {
    return undefined;
  }
}
