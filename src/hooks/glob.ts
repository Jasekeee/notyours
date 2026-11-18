// Minimal glob matcher (no new dependencies): `**`, `*`, `?`, `{a,b}`, `[...]`.
// Paths are project-relative with `/` separators. A pattern with no wildcard also matches everything under it.
import path from 'node:path';

const SPECIAL = /[.+^$()|\\]/;

function source(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const segStart = i === 0 || glob[i - 1] === '/';
        if (segStart && glob[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` matches zero or more directories
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += `(?:${glob.slice(i + 1, end).split(',').map(source).join('|')})`;
        i = end;
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        const body = glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
        re += `[${body}]`;
        i = end;
      }
    } else re += SPECIAL.test(c) ? `\\${c}` : c;
  }
  return re;
}

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const g = normalizeGlob(glob);
  let re = cache.get(g);
  if (!re) {
    const literal = !/[*?[{]/.test(g);
    // `dir/**` and a plain `dir` both cover the directory and everything under it.
    const dirGlob = g.endsWith('/**') ? g.slice(0, -3) : undefined;
    re =
      dirGlob !== undefined
        ? new RegExp(`^${source(dirGlob)}(?:/.*)?$`)
        : new RegExp(`^${source(g)}${literal ? '(?:/.*)?' : ''}$`);
    cache.set(g, re);
  }
  return re;
}

function normalizeGlob(glob: string): string {
  return glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function matchesGlob(relPath: string, glob: string): boolean {
  return globToRegExp(glob).test(relPath);
}

/** Project-relative POSIX path, or undefined when the file is outside the project. */
export function toProjectPath(projectDir: string, filePath: string): string | undefined {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(projectDir, filePath);
  const rel = path.relative(path.resolve(projectDir), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}
