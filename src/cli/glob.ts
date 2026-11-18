// Minimal glob matcher for boundary `surface` globs (no dependency): ** spans directories, * and ? do not.
// Brackets are literal so Next.js paths like app/notes/[id]/** work as written.

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '';
  const g = glob.replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

/** True if a project-relative path (forward slashes) matches the glob. A plain directory matches everything under it. */
export function matchesGlob(file: string, glob: string): boolean {
  const f = file.replace(/^\.\//, '');
  if (globToRegExp(glob).test(f)) return true;
  if (glob.endsWith('/**') && f === glob.slice(0, -3).replace(/^\.\//, '')) return true; // dir/** includes dir
  const dir = glob.replace(/\/+$/, '');
  return !/[*?]/.test(dir) && f.startsWith(`${dir}/`);
}
