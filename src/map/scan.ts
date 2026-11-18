// Static route scan (no AI): Express routes and Next.js app/ (and pages/) routes, with cheap heuristics
// for "reads per-user data" and "has a plan/pro/subscription check". Drafts only: a coding agent refines them.
import fs from 'node:fs';
import path from 'node:path';

export type Framework = 'express' | 'next-app' | 'next-pages';

export interface Route {
  /** HTTP method, or PAGE for a Next.js page. */
  method: string;
  /** Path as written: /notes/:id (Express) or /notes/[id] (Next). */
  path: string;
  framework: Framework;
  /** Project-relative, forward slashes. */
  file: string;
  line: number;
  params: string[];
  perUser: boolean;
  planGate: boolean;
  /** True for JSON endpoints (Next route handlers, pages/api, Express paths under /api). */
  api: boolean;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.vercel', '.notyours', '.testmuai', '.cache']);
const CODE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MAX_FILE_BYTES = 1024 * 1024;

/** Reads data from a store (DB, ORM, file, fetch). */
export const DATA_READ_RE =
  /\b(?:prisma|db|database|knex|sequelize|mongoose|supabase|drizzle|sql|pool|query|findUnique|findFirst|findOne|findById|findByPk|findMany|findAll|getDoc|getDocs|collection|readFile|repo|repository)\b|\bSELECT\b/;
/** Knows who the current user is. */
export const USER_CTX_RE = /\breq\.user\b|\breq\.session\b|\bsession\b|\bcurrentUser\b|\bgetServerSession\b|\bgetSession\b|\bauth\(\)|\buserId\b|\bownerId\b|\buser_id\b|\bowner_id\b|\bgetUser\b|\bcookies\(\)/;
/** Plan / pro / subscription checks. */
export const PLAN_RE = /\b(?:isPro|is_pro|plan|subscription|subscribed|premium|tier|entitlements?)\b|['"`]pro['"`]|\bstripe\b/i;

export function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(path.join(dir, e.name));
      } else if (e.isFile() && CODE_EXT.test(e.name) && !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(e.name)) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  visit(root);
  return out.sort();
}

const rel = (root: string, f: string) => path.relative(root, f).split(path.sep).join('/');
const lineAt = (src: string, idx: number) => src.slice(0, idx).split('\n').length;

export function expressParams(p: string): string[] {
  return [...p.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)\??/g)].map((m) => m[1]!);
}

export function nextParams(p: string): string[] {
  return [...p.matchAll(/\[\[?(?:\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\]?\]/g)].map((m) => m[1]!);
}

function classify(text: string): { perUser: boolean; planGate: boolean } {
  return { perUser: DATA_READ_RE.test(text) || USER_CTX_RE.test(text), planGate: PLAN_RE.test(text) };
}

// ---------- Express ----------

const METHOD_CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])(\/[^'"`]*)\3/g;
const ROUTE_CHAIN_RE = /\.\s*route\s*\(\s*(['"`])(\/[^'"`]*)\1\s*\)/g;

/** Express routes in one file. The handler text runs from the route call to the next route call. */
export function scanExpressSource(src: string, file: string): Route[] {
  if (!/\bexpress\b|\bRouter\s*\(/.test(src)) return [];
  const found: Array<{ method: string; path: string; idx: number; argsStart: number }> = [];
  for (const m of src.matchAll(METHOD_CALL_RE)) {
    if (/^(?:axios|fetch|http|https|request|client|api|superagent|ky|got|cy|page|res|map|cache|params|searchParams|headers)$/i.test(m[1]!)) continue;
    found.push({ method: m[2]!.toUpperCase(), path: m[4]!, idx: m.index, argsStart: m.index + m[0].length });
  }
  for (const m of src.matchAll(ROUTE_CHAIN_RE)) {
    const chain = src.slice(m.index + m[0].length, m.index + m[0].length + 3000).split(/\.\s*route\s*\(|;\s*\n/)[0]!;
    for (const c of chain.matchAll(/\.\s*(get|post|put|patch|delete|all)\s*\(/g)) {
      found.push({ method: c[1]!.toUpperCase(), path: m[2]!, idx: m.index, argsStart: m.index + m[0].length + c.index + c[0].length });
    }
  }
  found.sort((a, b) => a.idx - b.idx || a.argsStart - b.argsStart);
  return found.map((f, i) => {
    const nextIdx = found.slice(i + 1).find((g) => g.idx > f.idx)?.idx ?? src.length;
    let handler = src.slice(f.idx, Math.min(nextIdx, f.idx + 4000));
    // Named handlers (app.get('/x', auth, getNote)): pull in their local definitions. Only bare identifier
    // arguments count, i.e. the text before any inline function body.
    const args = (src.slice(f.argsStart, f.argsStart + 300).split(/[({]|=>|\)\s*;/)[0] ?? '').split(',');
    for (const name of args.map((a) => a.trim()).filter((a) => /^[A-Za-z_$][\w$]*$/.test(a) && a !== 'async' && a !== 'function')) {
      const esc = name.replace(/\$/g, '\\$');
      const def = new RegExp(`(?:function\\s+${esc}\\b|\\b(?:const|let|var)\\s+${esc}\\s*=)`).exec(src);
      if (!def) continue;
      const stop = found.find((g) => g.idx > def.index)?.idx ?? src.length;
      handler += `\n${src.slice(def.index, Math.min(stop, def.index + 3000))}`;
    }
    return {
      method: f.method,
      path: f.path,
      framework: 'express' as const,
      file,
      line: lineAt(src, f.idx),
      params: expressParams(f.path),
      api: f.path.startsWith('/api'),
      ...classify(handler),
    };
  });
}

// ---------- Next.js ----------

/** app/notes/[id]/page.tsx -> /notes/[id]. Route groups (x), slots @x and private _x are handled like Next does. */
export function nextAppRoute(relFile: string): { path: string; kind: 'page' | 'route' } | undefined {
  const parts = relFile.split('/');
  const appIdx = parts.findIndex((p, i) => p === 'app' && (i === 0 || (i === 1 && parts[0] === 'src')));
  if (appIdx < 0) return undefined;
  const base = parts[parts.length - 1]!;
  const kind = /^page\.(?:[jt]sx?|mdx)$/.test(base) ? 'page' : /^route\.[jt]sx?$/.test(base) ? 'route' : undefined;
  if (!kind) return undefined;
  const segs = parts.slice(appIdx + 1, -1);
  if (segs.some((s) => s.startsWith('_'))) return undefined;
  const kept = segs.filter((s) => !(s.startsWith('(') && s.endsWith(')')) && !s.startsWith('@'));
  return { path: `/${kept.join('/')}`, kind };
}

/** pages/api/notes/[id].ts -> /api/notes/[id]; pages/index.tsx -> / */
export function nextPagesRoute(relFile: string): string | undefined {
  const parts = relFile.split('/');
  const idx = parts.findIndex((p, i) => p === 'pages' && (i === 0 || (i === 1 && parts[0] === 'src')));
  if (idx < 0) return undefined;
  const segs = parts.slice(idx + 1);
  const last = segs.pop()!.replace(/\.[jt]sx?$/, '');
  if (last.startsWith('_')) return undefined;
  if (last !== 'index') segs.push(last);
  return `/${segs.join('/')}`;
}

export function scanNextFile(src: string, file: string): Route[] {
  const app = nextAppRoute(file);
  if (app) {
    const params = nextParams(app.path);
    const cls = classify(src);
    if (app.kind === 'page') return [{ method: 'PAGE', path: app.path, framework: 'next-app', file, line: 1, params, api: false, ...cls }];
    const methods = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)];
    return (methods.length ? methods : [{ 1: 'GET', index: 0 } as unknown as RegExpMatchArray]).map((m) => ({
      method: m[1]!,
      path: app.path,
      framework: 'next-app' as const,
      file,
      line: lineAt(src, m.index ?? 0),
      params,
      api: true,
      ...cls,
    }));
  }
  const pages = /\.[jt]sx?$/.test(file) ? nextPagesRoute(file) : undefined;
  if (pages !== undefined) {
    const api = pages.startsWith('/api');
    return [{ method: api ? 'ANY' : 'PAGE', path: pages, framework: 'next-pages', file, line: 1, params: nextParams(pages), api, ...classify(src) }];
  }
  return [];
}

export function scanProject(root: string): Route[] {
  const routes: Route[] = [];
  for (const abs of walk(root)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.size > MAX_FILE_BYTES) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const file = rel(root, abs);
    routes.push(...scanNextFile(src, file), ...scanExpressSource(src, file));
  }
  return routes;
}
