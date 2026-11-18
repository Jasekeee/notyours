// End-to-end engine tests: real Chrome (headless), real oracle, real fixture app; a fake runner stands in
// for Kane (it plants notes directly), so these cost no credits.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../schemas.js';
import type { Boundary, Config, Identity } from '../../types.js';
import { ChromePool } from '../chrome.js';
import { byId, createIdentities } from '../identities.js';
import { KaneEngine } from '../index.js';
import type { KaneRunner } from '../kane.js';
import { startFixture, type FixtureApp } from './fixture-app.js';

const CREATE = 'Create a note containing {{token}} and store the current page URL as item_url';
const SEEDED = 'Go to the seeded note, verify it contains {{token}}, store the current page URL as item_url';
let seededUrl = '';
let app: FixtureApp;
let cfg: Config;
let ids: Identity[];
let pool: ChromePool;
let engine: KaneEngine;
const stateDir = mkdtempSync(join(tmpdir(), 'ny-engine-'));
const objectives: string[] = [];

/** Fake Kane: the create objective plants a note with the identity's token; anything else is a no-op. */
const fakeRunner: KaneRunner = async (objective, identity, vars) => {
  objectives.push(`${identity.id}: ${objective}`);
  const stored: Record<string, string> = {};
  if (objective === SEEDED) {
    // Seed-confirm objective (fixed owner URL): works for the owner, fails for anyone else.
    if (identity.id !== 'alice') return { run: { objective, identity: identity.id, status: 'failed', exitCode: 1, finalState: {}, creditsConsumed: 0, durationS: 0.1 }, stored, text: 'note does not contain the token' };
    stored.item_url = seededUrl;
  } else if (objective === CREATE) {
    const token = typeof vars.token === 'string' ? vars.token : vars.token!.value;
    const n = app.addNote(identity.email!, `Note ${token}`, `Secret body ${token}`);
    stored.item_url = `${app.url}/notes/${n.id}`;
  } else {
    // Like Kane: open the {{tN}} pages in the identity's own Chrome first (this warms its HTTP cache).
    const urls = Object.entries(vars).filter(([k]) => /^t\d+$/.test(k)).map(([, v]) => (typeof v === 'string' ? v : v.value));
    if (urls.length) {
      const b = await puppeteer.connect({ browserURL: (await pool.get(identity)).endpoint, defaultViewport: null });
      const p = (await b.pages())[0] ?? (await b.newPage());
      for (const u of urls) await p.goto(u, { waitUntil: 'networkidle2' }).catch(() => {});
      await b.disconnect();
    }
  }
  return { run: { objective, identity: identity.id, status: 'passed', exitCode: 0, finalState: {}, creditsConsumed: 0, durationS: 0.1 }, stored, text: '' };
};

async function logIn(identity: Identity) {
  const h = await pool.get(identity);
  const browser = await puppeteer.connect({ browserURL: h.endpoint });
  await browser.setCookie({ name: 'sid', value: app.sessionFor(identity.email!), domain: '127.0.0.1', path: '/', httpOnly: true, expires: Date.now() / 1000 + 3600 });
  await browser.disconnect();
}

const boundary = (over: Partial<Boundary>): Boundary => ({
  id: 'b', kind: 'cross-user', owner: 'alice', viewer: 'bob',
  create: { objective: CREATE, store: ['item_url'] }, targets: { ui: ['{{item_url}}'], api: [] },
  expect: 'denied', surface: ['src/notes/**'], ...over,
});

beforeAll(async () => {
  app = await startFixture();
  cfg = ConfigSchema.parse({ baseUrl: app.url });
  ids = createIdentities([
    { id: 'alice', role: 'owner', plan: null },
    { id: 'bob', role: 'viewer', plan: null },
    { id: 'guest', role: 'guest', plan: null },
    { id: 'free_user', role: 'free', plan: 'free' },
    { id: 'pro_user', role: 'pro', plan: 'pro' },
    { id: 'dave', role: 'viewer', plan: null }, // has an account but is never logged in
  ], { stateDir, basePort: 9411 });
  for (const i of ids) if (i.email) app.addUser(i.email, i.password!, i.plan === 'pro' ? 'pro' : 'free');
  pool = new ChromePool({ headful: false });
  for (const id of ['alice', 'bob', 'free_user', 'pro_user']) await logIn(byId(ids, id));
  engine = new KaneEngine({ runner: fakeRunner, pool, stateDir, runId: 'test' });
}, 60_000);

afterAll(async () => {
  await pool?.closeAll();
  await app?.close();
  rmSync(stateDir, { recursive: true, force: true });
});

const alice = () => byId(ids, 'alice');

describe('engine (fake Kane, real Chrome + oracle)', () => {
  it('visible leak: viewer opens the owner note page (IDOR) -> LEAK_VISIBLE', async () => {
    const r = await engine.runBoundary(boundary({ id: 'visible' }), ids, cfg);
    expect(r.verdict).toBe('LEAK_VISIBLE');
    expect(r.controls).toEqual({ ownerSeesOwnToken: true, viewerSeesOwnToken: true });
    expect(r.hits.some((h) => h.where === 'dom' && h.token === alice().token)).toBe(true);
    expect(r.screenshots.length).toBeGreaterThan(0);
    for (const s of r.screenshots) expect(existsSync(s)).toBe(true);
    expect(r.kaneRuns.map((k) => k.identity)).toEqual(['alice', 'bob', 'bob']); // create, create, visit
  }, 60_000);

  it('payload-only leak: page hides the note but its JSON API sends it -> LEAK_PAYLOAD', async () => {
    const r = await engine.runBoundary(boundary({ id: 'payload', targets: { ui: ['{{item_url}}/preview'], api: [] } }), ids, cfg);
    expect(r.verdict).toBe('LEAK_PAYLOAD');
    expect(r.hits.every((h) => h.where === 'network')).toBe(true);
    expect(r.hits.some((h) => /\/api\/notes\//.test(h.url) && h.token === alice().token)).toBe(true);
    expect(r.controls).toEqual({ ownerSeesOwnToken: true, viewerSeesOwnToken: true });
    // The oracle's own visit (after "Kane" warmed the cache) must still see the payload: hit page screenshot.
    expect(r.screenshots.some((s) => s.endsWith('payload-bob-leak-ui0.png'))).toBe(true);
  }, 60_000);

  it('URL echo is not a leak: a 404 that repeats the requested path -> HELD', async () => {
    const r = await engine.runBoundary(boundary({ id: 'echo', targets: { ui: ['{{item_url}}/safe', '{{base_url}}/missing/{{token}}'], api: [] } }), ids, cfg);
    expect(r.hits).toEqual([]);
    expect(r.verdict).toBe('HELD');
    // The echo really happened: the 404 page shows the owner's token in "Cannot GET /missing/<token>".
    const html = await (await fetch(`${app.url}/missing/${alice().token}`)).text();
    expect(html).toContain(`Cannot GET /missing/${alice().token}`);
  }, 60_000);

  it('broken viewer login -> HARNESS_BROKEN (not HELD)', async () => {
    const r = await engine.runBoundary(boundary({ id: 'broken', viewer: 'dave', targets: { ui: ['{{item_url}}/safe'], api: [] } }), ids, cfg);
    expect(r.verdict).toBe('HARNESS_BROKEN');
    expect(r.controls).toEqual({ ownerSeesOwnToken: true, viewerSeesOwnToken: false });
    const diag = JSON.parse(readFileSync(join(stateDir, 'runs', 'test', 'broken.json'), 'utf8'));
    expect(diag.notes.join(' ')).toMatch(/viewer did not see its own token/);
  }, 60_000);

  it('safe route with working controls -> HELD', async () => {
    const r = await engine.runBoundary(boundary({ id: 'safe', targets: { ui: ['{{item_url}}/safe'], api: [] } }), ids, cfg);
    expect(r.verdict).toBe('HELD');
  }, 60_000);

  it('plan-gate: free user gets the pro export -> leak; gated export -> HELD', async () => {
    const pg = (id: string, path: string) => boundary({ id, kind: 'plan-gate', owner: 'pro_user', viewer: 'free_user', proAction: { objective: 'Open the export page' }, targets: { ui: [`{{base_url}}${path}`], api: [] } });
    const leaky = await engine.runBoundary(pg('pg-leaky', '/export-leaky'), ids, cfg);
    expect(leaky.verdict).toBe('LEAK_VISIBLE');
    expect(leaky.hits.every((h) => h.token === byId(ids, 'free_user').token)).toBe(true);
    const gated = await engine.runBoundary(pg('pg-gated', '/export'), ids, cfg);
    expect(gated.verdict).toBe('HELD');
    expect(gated.controls).toEqual({ ownerSeesOwnToken: true, viewerSeesOwnToken: true });
  }, 60_000);

  it('plan-gate via a POST-only API: leaky export -> LEAK_PAYLOAD; gated -> HELD', async () => {
    const pg = (id: string, api: string) => boundary({ id, kind: 'plan-gate', owner: 'pro_user', viewer: 'free_user', proAction: { objective: 'Export my notes' }, targets: { ui: [], api: [api] } });
    const leaky = await engine.runBoundary(pg('pg-post-leaky', 'POST {{base_url}}/api/export-leaky'), ids, cfg);
    expect(leaky.verdict).toBe('LEAK_PAYLOAD');
    expect(leaky.hits.length).toBeGreaterThan(0);
    expect(leaky.hits.every((h) => h.where === 'network' && h.token === byId(ids, 'free_user').token)).toBe(true);
    const gated = await engine.runBoundary(pg('pg-post-gated', 'POST {{base_url}}/api/export'), ids, cfg);
    expect(gated.verdict).toBe('HELD');
    expect(gated.controls).toEqual({ ownerSeesOwnToken: true, viewerSeesOwnToken: true });
  }, 60_000);

  it('wrong method on a POST-only API (405) is never HELD -> HARNESS_BROKEN', async () => {
    const b = boundary({ id: 'pg-wrong-method', kind: 'plan-gate', owner: 'pro_user', viewer: 'free_user', proAction: { objective: 'Export my notes' }, targets: { ui: ['{{base_url}}/export'], api: ['{{base_url}}/api/export'] } });
    const r = await engine.runBoundary(b, ids, cfg);
    // Both controls pass (gated UI export works for pro), so only the 405 stops this from reading as HELD.
    expect(r.controls).toEqual({ ownerSeesOwnToken: true, viewerSeesOwnToken: true });
    expect(r.hits).toEqual([]);
    expect(r.verdict).toBe('HARNESS_BROKEN');
    const diag = JSON.parse(readFileSync(join(stateDir, 'runs', 'test', 'pg-wrong-method.json'), 'utf8'));
    expect(diag.notes.join(' ')).toMatch(/answered 405/);
  }, 60_000);

  it('seeded boundary: the viewer cannot run the owner-only create, the probe still finds the leak', async () => {
    seededUrl = `${app.url}/notes/${app.addNote(alice().email!, 'Seeded', `Seeded body ${alice().token}`).id}`;
    const r = await engine.runBoundary(boundary({ id: 'seeded', create: { objective: SEEDED, store: ['item_url'] } }), ids, cfg);
    expect(r.verdict).toBe('LEAK_VISIBLE');
    expect(r.kaneRuns.map((k) => `${k.identity}:${k.status}`).sort()).toEqual(['alice:passed', 'bob:failed', 'bob:passed']);
    const diag = JSON.parse(readFileSync(join(stateDir, 'runs', 'test', 'seeded.json'), 'utf8'));
    expect(diag.notes.join(' ')).toMatch(/viewer create run failed/);
  }, 60_000);

  it('guest: fresh profile, no login, sees nothing -> HELD', async () => {
    const r = await engine.runBoundary(boundary({ id: 'guest', kind: 'guest', viewer: 'guest' }), ids, cfg);
    expect(r.verdict).toBe('HELD');
    expect(r.kaneRuns.map((k) => k.identity)).toEqual(['alice', 'guest']); // no guest create
  }, 60_000);

  it('sweep: viewer browses its own list; another identity token there would be a leak -> HELD', async () => {
    const r = await engine.runBoundary(boundary({ id: 'sweep', kind: 'sweep', targets: { ui: ['{{base_url}}/notes'], api: [] } }), ids, cfg);
    expect(r.verdict).toBe('HELD');
    expect(r.controls.viewerSeesOwnToken).toBe(true);
  }, 60_000);

  it('refuses hosts outside allowHosts before any Kane run', async () => {
    const before = objectives.length;
    const bad = ConfigSchema.parse({ baseUrl: 'http://staging.example.net' });
    await expect(engine.runBoundary(boundary({ id: 'bad-host' }), ids, bad)).rejects.toThrow(/not in allowHosts/);
    expect(objectives.length).toBe(before);
  });

  it('refuses an unreachable app before any Kane run', async () => {
    const before = objectives.length;
    const down = ConfigSchema.parse({ baseUrl: 'http://127.0.0.1:9' });
    await expect(engine.runBoundary(boundary({ id: 'down' }), ids, down)).rejects.toThrow(/not reachable.*no Kane runs/);
    expect(objectives.length).toBe(before);
  });
});
