// Writes under a project root that refuse to follow symlinks. A cloned repo could ship `.notyours` or
// `.notyours/map.json` as a symlink to e.g. ~/.bashrc; we must never write through it.
import fs from 'node:fs';
import path from 'node:path';

export class SymlinkError extends Error {
  constructor(p: string) {
    super(`Refusing to write through a symlink: ${p}. Remove the link and retry.`);
    this.name = 'SymlinkError';
  }
}

/** Throws if any existing component of `target` below `root` (including target itself) is a symlink. */
export function assertNoSymlinks(root: string, target: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Refusing to write outside the project: ${target}`);
  let cur = path.resolve(root);
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing further exists yet
      throw e;
    }
    if (st.isSymbolicLink()) throw new SymlinkError(cur);
  }
}

export function safeMkdir(root: string, dir: string): void {
  assertNoSymlinks(root, dir);
  fs.mkdirSync(dir, { recursive: true });
}

export function safeWriteFile(root: string, file: string, data: string, opts: fs.WriteFileOptions = {}): void {
  safeMkdir(root, path.dirname(file));
  assertNoSymlinks(root, file);
  fs.writeFileSync(file, data, opts);
  // `mode` only applies when the file is created; tighten an existing file too (e.g. secrets.json at 0644).
  const mode = typeof opts === 'object' && opts !== null ? opts.mode : undefined;
  if (mode !== undefined) fs.chmodSync(file, mode);
}

export function safeAppendFile(root: string, file: string, data: string): void {
  safeMkdir(root, path.dirname(file));
  assertNoSymlinks(root, file);
  fs.appendFileSync(file, data);
}
