// `notyours map`: static scan -> .notyours/boundaries/_draft_*.yaml + .notyours/map.json. No AI, no Kane.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Boundary, Identity } from '../types.js';
import { safeMkdir, safeWriteFile } from '../cli/safe-fs.js';
import { scanProject, type Route } from './scan.js';

export { scanProject, scanExpressSource, scanNextFile, nextAppRoute, nextPagesRoute, type Route } from './scan.js';
export { MAP_COMMAND_MD } from './command.js';

export interface MapOptions {
  root: string;
  baseUrl?: string;
  /** Identities (only id/role/plan are used; never written with secrets). */
  identities?: Pick<Identity, 'id' | 'role' | 'plan'>[];
  now?: () => Date;
}

export interface Draft {
  boundary: Boundary;
  file: string;
  routes: Route[];
  /** A real boundary with this id already exists, so no draft was written. */
  skipped: boolean;
}

export interface MapResult {
  routes: Route[];
  drafts: Draft[];
  mapFile: string;
}

export function slug(p: string): string {
  const s = p
    .toLowerCase()
    .replace(/\[\[?\.\.\.|\]\]?|\[/g, '')
    .replace(/:/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'root').slice(0, 48).replace(/-+$/, '');
}

/** /notes/:id or /notes/[id] -> /notes/{{id}} (Kane variable syntax). */
export function templatePath(p: string): string {
  return p.replace(/:([A-Za-z_]\w*)\??/g, '{{$1}}').replace(/\[\[?(?:\.\.\.)?([A-Za-z_]\w*)\]?\]/g, '{{$1}}');
}

const READ_METHODS = new Set(['GET', 'ALL', 'PAGE', 'ANY']);
const routeKey = (r: Route) => `${r.method} ${r.path}`;

function pickIds(identities: MapOptions['identities']) {
  const list = identities ?? [];
  return {
    owner: list.find((i) => i.role === 'owner')?.id ?? 'alice',
    viewer: list.find((i) => i.role === 'viewer')?.id ?? 'bob',
    free: list.find((i) => i.role === 'free' || (i.plan === 'free' && i.role !== 'viewer'))?.id ?? 'free_user',
  };
}

function surfaceFor(routes: Route[]): string[] {
  const out = new Set<string>();
  for (const r of routes) {
    out.add(r.file);
    if (r.framework === 'next-app') out.add(`${path.posix.dirname(r.file)}/**`);
  }
  return [...out];
}

function targetsFor(routes: Route[], base: string, params: string[]): Boundary['targets'] {
  const ui = new Set<string>();
  const api = new Set<string>();
  for (const r of routes) {
    const url = `${base}${templatePath(r.path)}`;
    (r.api ? api : ui).add(params.length && !r.api && params.length === 1 ? '{{record_url}}' : url);
  }
  return { ui: [...ui], api: [...api] };
}

/** Build drafts from scanned routes: one cross-user draft per param route that reads per-user data, one plan-gate draft per plan check. */
export function buildDrafts(routes: Route[], opts: Pick<MapOptions, 'baseUrl' | 'identities'>): Array<{ boundary: Boundary; routes: Route[] }> {
  const base = (opts.baseUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
  const ids = pickIds(opts.identities);
  const byPath = new Map<string, Route[]>();
  for (const r of routes) {
    const k = templatePath(r.path);
    byPath.set(k, [...(byPath.get(k) ?? []), r]);
  }
  const drafts: Array<{ boundary: Boundary; routes: Route[] }> = [];
  for (const [tpl, group] of byPath) {
    const reads = group.filter((r) => r.params.length > 0 && r.perUser && READ_METHODS.has(r.method));
    if (reads.length) {
      const params = [...new Set(reads.flatMap((r) => r.params))];
      const hasPage = reads.some((r) => !r.api);
      const store = [...new Set([...(hasPage && params.length === 1 ? ['record_url'] : []), ...params])];
      drafts.push({
        routes: reads,
        boundary: {
          id: `${slug(tpl)}-cross-user`,
          kind: 'cross-user',
          owner: ids.owner,
          viewer: ids.viewer,
          create: {
            objective:
              `TODO: as ${ids.owner}, go to ${base}/... and create the record that ${tpl} shows, ` +
              `putting {{token}} in a visible text field (title, name or memo). ` +
              `Then store ${store.map((s) => `'${s}'`).join(' and ')} (${hasPage ? 'the new record URL and its ' : 'its '}${params.join('/')}).`,
            store,
          },
          targets: targetsFor(reads, base, params),
          expect: 'denied',
          surface: surfaceFor(reads),
        },
      });
    }
    const gates = group.filter((r) => r.planGate);
    if (gates.length) {
      drafts.push({
        routes: gates,
        boundary: {
          id: `${slug(tpl)}-plan-gate`,
          kind: 'plan-gate',
          owner: ids.free,
          viewer: ids.free,
          create: {
            objective: `TODO: as ${ids.free} (free plan), create data containing {{token}} that the Pro-only feature at ${base}${tpl} would expose.`,
            store: [],
          },
          targets: { ui: gates.some((r) => !r.api) ? [`${base}${tpl}`] : [], api: gates.some((r) => r.api) ? [`${base}${tpl}`] : [] },
          proAction: { objective: `TODO: as ${ids.free}, try the Pro-only action behind ${gates.map(routeKey).join(', ')}.` },
          expect: 'denied',
          surface: surfaceFor(gates),
        },
      });
    }
  }
  // Ids must be unique even when two templates slug the same.
  const seen = new Map<string, number>();
  for (const d of drafts) {
    const n = (seen.get(d.boundary.id) ?? 0) + 1;
    seen.set(d.boundary.id, n);
    if (n > 1) d.boundary.id = `${d.boundary.id}-${n}`;
  }
  return drafts;
}

function draftYaml(b: Boundary, routes: Route[]): string {
  const found = routes.map((r) => `#   ${routeKey(r)}  (${r.file}:${r.line})`).join('\n');
  const why = b.kind === 'plan-gate' ? 'has a plan/pro/subscription check' : 'takes an id and reads per-user data';
  return `# DRAFT boundary from \`notyours map\` (static scan, no AI). This route ${why}:
${found}
# Finish it with /notyours-map in Claude Code, or by hand:
#   create.objective  what ${b.owner} does in the UI to create a record containing {{token}}
#   create.store      Kane variables to save (e.g. the new record's URL)
#   targets.ui/api    where ${b.viewer} looks for it (may use {{stored}} values)
#   surface           code that enforces this boundary
# Then save it as .notyours/boundaries/${b.id}.yaml (no _draft_ prefix) and delete this file.
${YAML.stringify(b, { lineWidth: 0 })}`;
}

export function runMap(opts: MapOptions): MapResult {
  const { root } = opts;
  const routes = scanProject(root);
  const bdir = path.join(root, '.notyours', 'boundaries');
  safeMkdir(root, bdir);

  const drafts: Draft[] = buildDrafts(routes, opts).map(({ boundary, routes: rs }) => {
    const file = path.join(bdir, `_draft_${boundary.id}.yaml`);
    const skipped = fs.existsSync(path.join(bdir, `${boundary.id}.yaml`));
    if (!skipped) safeWriteFile(root, file, draftYaml(boundary, rs));
    return { boundary, file, routes: rs, skipped };
  });

  const map: Record<string, { framework: string; files: string[]; line: number; params: string[]; perUser: boolean; planGate: boolean; api: boolean; drafts: string[] }> = {};
  for (const r of routes) {
    const k = routeKey(r);
    const prev = map[k];
    const draftIds = drafts.filter((d) => d.routes.includes(r)).map((d) => d.boundary.id);
    if (prev) {
      prev.files = [...new Set([...prev.files, r.file])];
      prev.drafts = [...new Set([...prev.drafts, ...draftIds])];
      prev.perUser ||= r.perUser;
      prev.planGate ||= r.planGate;
    } else {
      map[k] = { framework: r.framework, files: [r.file], line: r.line, params: r.params, perUser: r.perUser, planGate: r.planGate, api: r.api, drafts: draftIds };
    }
  }
  const mapFile = path.join(root, '.notyours', 'map.json');
  const doc = {
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    baseUrl: opts.baseUrl,
    note: 'Static scan. Paths are as written in code: Express router mount prefixes (app.use("/api", router)) are not resolved.',
    identities: (opts.identities ?? []).map((i) => ({ id: i.id, role: i.role, plan: i.plan })),
    routes: map,
  };
  safeWriteFile(root, mapFile, `${JSON.stringify(doc, null, 2)}\n`);
  return { routes, drafts, mapFile };
}
