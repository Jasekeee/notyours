import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { BoundarySchema } from '../schemas.js';
import { MAP_COMMAND_MD, nextAppRoute, nextPagesRoute, runMap, scanExpressSource } from './index.js';
import { slug, templatePath } from './index.js';

const EXPRESS_APP = `
import express from 'express';
const app = express();
const router = express.Router();

app.get('/health', (req, res) => res.send('ok'));

app.get('/notes/:id', requireAuth, async (req, res) => {
  const note = await db.get('SELECT * FROM notes WHERE id = ?', req.params.id);
  res.json(note);
});

app.delete('/notes/:id', requireAuth, async (req, res) => {
  await db.run('DELETE FROM notes WHERE id = ?', req.params.id);
});

router.get('/api/invoices/:invoiceId', getInvoice);

async function getInvoice(req, res) {
  res.json(await prisma.invoice.findUnique({ where: { id: req.params.invoiceId } }));
}

app.post('/export', (req, res) => {
  if (req.user.plan !== 'pro') return res.status(402).end();
  res.send(csv(req.user.notes));
});

router.route('/files/:name').get((req, res) => res.sendFile(req.params.name));

axios.get('/api/should-not-count/:x');
`;

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-map-'));
  const w = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  w('server.ts', EXPRESS_APP);
  w('src/app/(dash)/projects/[projectId]/page.tsx', `export default async function P({ params }) { const p = await prisma.project.findUnique({ where: { id: params.projectId } }); return <h1>{p.name}</h1>; }`);
  w('src/app/api/projects/[projectId]/route.ts', `export async function GET(req, { params }) { const s = await getServerSession(); return Response.json(await db.project(params.projectId)); }\nexport async function DELETE() {}`);
  w('src/app/billing/page.tsx', `export default function B() { const { subscription } = useUser(); return subscription?.tier === 'pro' ? <Pro/> : <Upsell/>; }`);
  w('src/app/about/page.tsx', `export default function A() { return <p>About</p>; }`);
  w('src/app/_lib/[x]/page.tsx', `export default function X() { return db.thing(); }`);
  w('pages/api/reports/[id].ts', `export default async function h(req, res) { res.json(await db.report.findFirst({ where: { id: req.query.id, ownerId: req.session.userId } })); }`);
  w('node_modules/evil/server.js', `const app = require('express')(); app.get('/x/:id', (r, s) => db.get())`);
  fs.mkdirSync(path.join(root, '.notyours/boundaries'), { recursive: true });
  // A real boundary already exists for one route: its draft must be skipped.
  w('.notyours/boundaries/api-projects-projectid-cross-user.yaml', 'id: api-projects-projectid-cross-user\n');
  return root;
}

describe('route helpers', () => {
  it('Next app router paths drop groups, slots and private folders', () => {
    expect(nextAppRoute('src/app/(dash)/projects/[projectId]/page.tsx')).toEqual({ path: '/projects/[projectId]', kind: 'page' });
    expect(nextAppRoute('app/api/x/[[...slug]]/route.ts')).toEqual({ path: '/api/x/[[...slug]]', kind: 'route' });
    expect(nextAppRoute('app/@modal/page.tsx')).toEqual({ path: '/', kind: 'page' });
    expect(nextAppRoute('app/_lib/page.tsx')).toBeUndefined();
    expect(nextAppRoute('app/layout.tsx')).toBeUndefined();
    expect(nextAppRoute('lib/app/page.tsx')).toBeUndefined();
    expect(nextPagesRoute('pages/api/reports/[id].ts')).toBe('/api/reports/[id]');
    expect(nextPagesRoute('src/pages/index.tsx')).toBe('/');
    expect(nextPagesRoute('pages/_app.tsx')).toBeUndefined();
  });

  it('slugs and Kane templates', () => {
    expect(slug('/notes/:id')).toBe('notes-id');
    expect(slug('/api/x/[[...slug]]')).toBe('api-x-slug');
    expect(slug('/')).toBe('root');
    expect(templatePath('/notes/:id/:rev?')).toBe('/notes/{{id}}/{{rev}}');
    expect(templatePath('/p/[projectId]/[...rest]')).toBe('/p/{{projectId}}/{{rest}}');
  });

  it('Express: methods, params, per-user and plan heuristics, named handlers, route() chains', () => {
    const routes = scanExpressSource(EXPRESS_APP, 'server.ts');
    const by = (m: string, p: string) => routes.find((r) => r.method === m && r.path === p);
    expect(by('GET', '/health')).toMatchObject({ params: [], perUser: false, planGate: false });
    expect(by('GET', '/notes/:id')).toMatchObject({ params: ['id'], perUser: true, line: 8 });
    expect(by('GET', '/api/invoices/:invoiceId')).toMatchObject({ perUser: true, api: true });
    expect(by('POST', '/export')).toMatchObject({ planGate: true });
    expect(by('GET', '/files/:name')).toMatchObject({ params: ['name'], perUser: false });
    expect(routes.find((r) => r.path.includes('should-not-count'))).toBeUndefined();
  });

  it('ignores files that are not Express', () => {
    expect(scanExpressSource(`axios.get('/notes/:id')`, 'client.ts')).toEqual([]);
  });
});

describe('runMap', () => {
  const root = makeProject();
  const result = runMap({
    root,
    baseUrl: 'http://localhost:3000',
    identities: [
      { id: 'alice', role: 'owner', plan: 'pro' },
      { id: 'bob', role: 'viewer', plan: 'free' },
      { id: 'free_user', role: 'free', plan: 'free' },
    ],
  });
  const ids = result.drafts.map((d) => d.boundary.id).sort();

  it('drafts a cross-user boundary per param route that reads per-user data, and a plan-gate per plan check', () => {
    expect(ids).toEqual([
      'api-invoices-invoiceid-cross-user',
      'api-projects-projectid-cross-user',
      'api-reports-id-cross-user',
      'billing-plan-gate',
      'export-plan-gate',
      'notes-id-cross-user',
      'projects-projectid-cross-user',
    ]);
  });

  it('writes schema-valid _draft_ YAML files and skips ids that already have a real boundary', () => {
    const dir = path.join(root, '.notyours/boundaries');
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('_draft_'));
    expect(files).toHaveLength(6);
    expect(files).not.toContain('_draft_api-projects-projectid-cross-user.yaml');
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(text.startsWith('# DRAFT boundary')).toBe(true);
      expect(() => BoundarySchema.parse(YAML.parse(text))).not.toThrow();
    }
    const notes = YAML.parse(fs.readFileSync(path.join(dir, '_draft_notes-id-cross-user.yaml'), 'utf8'));
    expect(notes).toMatchObject({ kind: 'cross-user', owner: 'alice', viewer: 'bob', expect: 'denied', surface: ['server.ts'] });
    expect(notes.targets.ui).toEqual(['{{record_url}}']);
    expect(notes.create.store).toEqual(['record_url', 'id']);
    const inv = YAML.parse(fs.readFileSync(path.join(dir, '_draft_api-invoices-invoiceid-cross-user.yaml'), 'utf8'));
    expect(inv.targets.api).toEqual(['http://localhost:3000/api/invoices/{{invoiceId}}']);
    const gate = YAML.parse(fs.readFileSync(path.join(dir, '_draft_export-plan-gate.yaml'), 'utf8'));
    expect(gate).toMatchObject({ kind: 'plan-gate', owner: 'free_user', viewer: 'free_user' });
    expect(gate.proAction.objective).toContain('POST /export');
    const proj = YAML.parse(fs.readFileSync(path.join(dir, '_draft_projects-projectid-cross-user.yaml'), 'utf8'));
    expect(proj.surface).toEqual(['src/app/(dash)/projects/[projectId]/page.tsx', 'src/app/(dash)/projects/[projectId]/**']);
  });

  it('drafts whose targets use stored values say they are not lockable on kane-cli 0.10.0 (audit P1-10)', () => {
    const dir = path.join(root, '.notyours/boundaries');
    const text = fs.readFileSync(path.join(dir, '_draft_notes-id-cross-user.yaml'), 'utf8');
    expect(text).toContain('# WARNING: not lockable on kane-cli 0.10.0. Its targets use stored values ({{record_url}})');
    expect(text).toMatch(/use fixed URLs instead: an existing record of alice .* and a `viewerOwn` page for bob/);
    const inv = fs.readFileSync(path.join(dir, '_draft_api-invoices-invoiceid-cross-user.yaml'), 'utf8');
    expect(inv).toContain('not lockable on kane-cli 0.10.0');
    // a plan-gate draft with fixed targets and nothing stored: no warning
    expect(fs.readFileSync(path.join(dir, '_draft_export-plan-gate.yaml'), 'utf8')).not.toContain('WARNING');
  });

  it('writes map.json: route -> files, without node_modules or private folders', () => {
    const map = JSON.parse(fs.readFileSync(result.mapFile, 'utf8'));
    expect(map.routes['GET /notes/:id'].files).toEqual(['server.ts']);
    expect(map.routes['GET /notes/:id'].drafts).toEqual(['notes-id-cross-user']);
    expect(map.routes['DELETE /notes/:id'].drafts).toEqual([]);
    expect(map.routes['PAGE /about']).toMatchObject({ perUser: false, drafts: [] });
    expect(map.routes['ANY /api/reports/[id]'].files).toEqual(['pages/api/reports/[id].ts']);
    expect(Object.keys(map.routes).some((k) => k.includes('/x/'))).toBe(false);
    expect(map.identities).toEqual([
      { id: 'alice', role: 'owner', plan: 'pro' },
      { id: 'bob', role: 'viewer', plan: 'free' },
      { id: 'free_user', role: 'free', plan: 'free' },
    ]);
  });
});

describe('runMap symlink safety', () => {
  it('refuses to write through a symlinked .notyours or map.json', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-outside-'));
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-link-'));
    fs.writeFileSync(path.join(a, 'server.ts'), EXPRESS_APP);
    fs.symlinkSync(outside, path.join(a, '.notyours'));
    expect(() => runMap({ root: a })).toThrow(/symlink/);
    expect(fs.readdirSync(outside)).toEqual([]);

    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-link-'));
    fs.mkdirSync(path.join(b, '.notyours'));
    const victim = path.join(outside, 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    fs.symlinkSync(victim, path.join(b, '.notyours', 'map.json'));
    expect(() => runMap({ root: b })).toThrow(/symlink/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
  });
});

describe('/notyours-map slash command', () => {
  it('the bundled copy matches .claude/commands/notyours-map.md', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    expect(MAP_COMMAND_MD).toBe(fs.readFileSync(path.join(repoRoot, '.claude/commands/notyours-map.md'), 'utf8'));
  });
});
