// End-to-end engine tests: real Chrome (headless), real oracle, real fixture app; a fake runner stands in
// for Kane (it plants notes directly), so these cost no credits.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundarySchema, ConfigSchema } from '../../schemas.js';
import type { Boundary, Config, Identity } from '../../types.js';
import { ChromePool, killLiveChromes } from '../chrome.js';
import { byId, createIdentities } from '../identities.js';
import { KaneEngine } from '../index.js';
import type { KaneRunner } from '../kane.js';
import { startFixture, type FixtureApp } from './fixture-app.js';
import { freePortRange, killChromesUsing } from './test-ports.js';

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
const names: string[] = [];
const fakeRunner: KaneRunner = async (objective, identity, vars, kopts) => {
  objectives.push(`${identity.id}: ${objective}`);
  if (kopts.name) names.push(kopts.name);
  const stored: Record<string, string> = {};
  // Objectives arrive with non-secret values inlined ({{token}} -> the identity's canary).
  const is = (template: string) => objective === template.replace('{{token}}', identity.token);
  if (is(SEEDED)) {
    // Seed-confirm objective (fixed owner URL): works for the owner, fails for anyone else.
    if (identity.id !== 'alice') return { run: { objective, identity: identity.id, status: 'failed', exitCode: 1, finalState: {}, creditsConsumed: 0, durationS: 0.1 }, stored, text: 'note does not contain the token' };
    stored.item_url = seededUrl;
  } else if (is(CREATE)) {
    expect(objective).not.toContain('{{token}}');
    const token = typeof vars.token === 'string' ? vars.token : vars.token!.value;
    const n = app.addNote(identity.email!, `Note ${token}`, `Secret body ${token}`);
    stored.item_url = `${app.url}/notes/${n.id}`;
  } else {
    // Like Kane: open the {{tN}} pages in the identity's own Chrome first (this warms its HTTP cache).
    // The visit objective lists its URLs literally (kane-cli needs a visible start URL).
    const urls = [...objective.matchAll(/https?:\/\/[^\s,]+/g)].map((m) => m[0].replace(/[.,]+$/, ''));
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
  ], { stateDir, basePort: await freePortRange(6) });
  for (const i of ids) if (i.email) app.addUser(i.email, i.password!, i.plan === 'pro' ? 'pro' : 'free');
  pool = new ChromePool({ headful: false });
  for (const id of ['alice', 'bob', 'free_user', 'pro_user']) await logIn(byId(ids, id));
  engine = new KaneEngine({ runner: fakeRunner, pool, stateDir, runId: 'test' });
}, 60_000);

// A file that aborts (hook timeout, crash) must not leave Chrome on the test ports: close the pool, then
// kill anything still running, even if closing failed. The exit handler covers a worker that dies outright.
process.once('exit', killLiveChromes);

afterAll(async () => {
  try {
    await pool?.closeAll();
    await app?.close();
  } finally {
    killLiveChromes();
    killChromesUsing(stateDir);
    rmSync(stateDir, { recursive: true, force: true });
  }
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

  it('AUD-12: a leak in an application/xml body is caught (all content types are scanned)', async () => {
    const r = await engine.runBoundary(boundary({ id: 'xml', targets: { ui: ['{{item_url}}/safe'], api: ['{{item_url}}/xml'] } }), ids, cfg);
    expect(r.verdict).toBe('LEAK_PAYLOAD');
    expect(r.hits.some((h) => h.url.endsWith('/xml') && h.token === alice().token)).toBe(true);
  }, 60_000);

  it('AUD-12: a leak in a text/javascript data response loaded by <script src> is caught (scripts with a text type are scanned)', async () => {
    const r = await engine.runBoundary(boundary({ id: 'script', targets: { ui: ['{{item_url}}/script-page'], api: [] } }), ids, cfg);
    expect(r.verdict).toBe('LEAK_PAYLOAD');
    expect(r.hits.some((h) => h.url.endsWith('/data.js') && h.token === alice().token)).toBe(true);
  }, 60_000);

  it('AUD-12: a leak body over the 2 MB scan cap is never HELD', async () => {
    const r = await engine.runBoundary(boundary({ id: 'big', targets: { ui: ['{{item_url}}/safe'], api: ['{{item_url}}/big'] } }), ids, cfg);
    expect(r.verdict).toBe('HARNESS_BROKEN');
    expect(r.hits).toEqual([]); // the token sits past the cap, so nothing was found, and that must not read as HELD
  }, 60_000);

  it("AUD-13: a viewer's 404 on an api target the owner never reached with 2xx is not a denial -> HARNESS", async () => {
    const r = await engine.runBoundary(boundary({
      id: 'viewer-404', kind: 'plan-gate', owner: 'pro_user', viewer: 'free_user', proAction: { objective: 'Export my notes' },
      targets: { ui: [], api: ['{{item_url}}/pro-raw'] },
    }), ids, cfg);
    expect(r.controls.ownerSeesOwnToken).toBe(true); // the pro owner's own raw call answered 200
    expect(r.verdict).toBe('HARNESS_BROKEN');
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

  describe('CC-1 viewerOwn', () => {
    const noteUrl = (id: string, body: string) => `${app.url}/notes/${app.addNote(byId(ids, id).email!, 'Seeded', body).id}`;

    it('schema: optional, needs both ui and api', () => {
      const base = boundary({ id: 'schema' });
      expect(BoundarySchema.safeParse(base).success).toBe(true);
      expect(BoundarySchema.safeParse({ ...base, viewerOwn: { ui: ['http://127.0.0.1/notes/2'], api: [] } }).success).toBe(true);
      expect(BoundarySchema.safeParse({ ...base, viewerOwn: { ui: ['http://127.0.0.1/notes/2'] } }).success).toBe(false);
    });

    it('seeded cross-user, safe route: viewer create skipped, control from viewerOwn -> HELD', async () => {
      seededUrl = noteUrl('alice', `Alice seed ${alice().token}`);
      const bobOwn = noteUrl('bob', `Bob seed ${byId(ids, 'bob').token}`);
      const r = await engine.runBoundary(boundary({
        id: 'own-held', create: { objective: SEEDED, store: ['item_url'] },
        targets: { ui: [`${seededUrl}/safe`], api: [] }, viewerOwn: { ui: [`${bobOwn}/safe`], api: [] },
      }), ids, cfg);
      expect(r.verdict).toBe('HELD');
      expect(r.controls).toEqual({ ownerSeesOwnToken: true, viewerSeesOwnToken: true });
      expect(r.kaneRuns.map((k) => `${k.identity}:${k.status}`)).toEqual(['alice:passed', 'bob:passed']); // owner create + viewer visit
      expect(r.screenshots).toEqual([]); // HELD: no hit pages, so no screenshots (control pages aren't screenshotted)
    }, 60_000);

    it('seeded cross-user, IDOR route: -> LEAK_VISIBLE with both controls', async () => {
      seededUrl = noteUrl('alice', `Alice seed ${alice().token}`);
      const bobOwn = noteUrl('bob', `Bob seed ${byId(ids, 'bob').token}`);
      const r = await engine.runBoundary(boundary({
        id: 'own-leak', create: { objective: SEEDED, store: ['item_url'] },
        targets: { ui: [seededUrl], api: [] }, viewerOwn: { ui: [bobOwn], api: [] },
      }), ids, cfg);
      expect(r.verdict).toBe('LEAK_VISIBLE');
      expect(r.controls).toEqual({ ownerSeesOwnToken: true, viewerSeesOwnToken: true });
    }, 60_000);

    it('B3 shape (plan-gate, store: [], POST export): gated -> HELD, leaky -> LEAK_PAYLOAD', async () => {
      noteUrl('pro_user', `Pro seed ${byId(ids, 'pro_user').token}`); // the pro owner's export must contain its own token
      const freeOwn = noteUrl('free_user', `Free seed ${byId(ids, 'free_user').token}`);
      const b3 = (id: string, api: string) => boundary({
        id, kind: 'plan-gate', owner: 'pro_user', viewer: 'free_user',
        create: { objective: 'Verify the export button is visible', store: [] },
        proAction: { objective: 'Export my notes' }, targets: { ui: [], api: [api] }, viewerOwn: { ui: [freeOwn], api: [] },
      });
      const gated = await engine.runBoundary(b3('own-b3-gated', 'POST {{base_url}}/api/export'), ids, cfg);
      expect(gated.verdict).toBe('HELD');
      expect(gated.controls).toEqual({ ownerSeesOwnToken: true, viewerSeesOwnToken: true });
      // no free create; pro create + both pro actions + the free user's recording visit of its own (non-gated) page
      expect(gated.kaneRuns.map((k) => k.identity).sort()).toEqual(['free_user', 'free_user', 'pro_user', 'pro_user']);
      const leaky = await engine.runBoundary(b3('own-b3-leaky', 'POST {{base_url}}/api/export-leaky'), ids, cfg);
      expect(leaky.verdict).toBe('LEAK_PAYLOAD');
    }, 60_000);

    it('a file-download target (Content-Disposition: attachment) is fetched and judged: gated -> HELD, leaky -> LEAK_PAYLOAD', async () => {
      noteUrl('pro_user', `Pro dl ${byId(ids, 'pro_user').token}`);
      const freeOwn = noteUrl('free_user', `Free dl ${byId(ids, 'free_user').token}`);
      const dl = (id: string, path: string, where: 'ui' | 'api') => boundary({
        id, kind: 'plan-gate', owner: 'pro_user', viewer: 'free_user',
        create: { objective: 'Verify the export link is visible', store: [] },
        proAction: { objective: 'Export my notes' },
        targets: where === 'ui' ? { ui: [`{{base_url}}${path}`], api: [] } : { ui: [], api: [`{{base_url}}${path}`] },
        viewerOwn: { ui: [freeOwn], api: [] },
      });
      for (const where of ['ui', 'api'] as const) {
        const gated = await engine.runBoundary(dl(`dl-gated-${where}`, '/export.txt', where), ids, cfg);
        expect(gated.verdict, where).toBe('HELD');
        expect(gated.controls, where).toEqual({ ownerSeesOwnToken: true, viewerSeesOwnToken: true }); // the pro owner's download was read
        const leaky = await engine.runBoundary(dl(`dl-leaky-${where}`, '/export-leaky.txt', where), ids, cfg);
        expect(leaky.verdict, where).toBe('LEAK_PAYLOAD');
      }
    }, 120_000);

    it('viewerOwn page the viewer cannot see (not signed in) -> HARNESS_BROKEN', async () => {
      seededUrl = noteUrl('alice', `Alice seed ${alice().token}`);
      const daveOwn = noteUrl('dave', `Dave seed ${byId(ids, 'dave').token}`);
      const r = await engine.runBoundary(boundary({
        id: 'own-broken', viewer: 'dave', create: { objective: SEEDED, store: ['item_url'] },
        targets: { ui: [`${seededUrl}/safe`], api: [] }, viewerOwn: { ui: [`${daveOwn}/safe`], api: [] },
      }), ids, cfg);
      expect(r.verdict).toBe('HARNESS_BROKEN');
      expect(r.controls.viewerSeesOwnToken).toBe(false);
    }, 60_000);
  });

  describe('integration: judge-only (ratchet) and recording names', () => {
    it('names the probe recordings <boundary>_<identity> for the ratchet to adopt', async () => {
      names.length = 0;
      await engine.runBoundary(boundary({ id: 'named', targets: { ui: ['{{item_url}}/safe'], api: [] } }), ids, cfg);
      expect(names.sort()).toEqual(['named_alice', 'named_bob']); // owner create + viewer visit (viewer create unnamed)
    }, 60_000);

    it('judge() never calls Kane and still judges (stored values from the replays)', async () => {
      const n = app.addNote(alice().email!, 'J', `J body ${alice().token}`);
      const own = app.addNote(byId(ids, 'bob').email!, 'J', `J body ${byId(ids, 'bob').token}`);
      const before = objectives.length;
      const replays = [{ objective: 'replay', identity: 'alice', status: 'passed' as const, exitCode: 0, finalState: { item_url: `${app.url}/notes/${n.id}` }, creditsConsumed: 0, durationS: 0.5 }];
      const b = boundary({ id: 'judged', viewerOwn: { ui: [`${app.url}/notes/${own.id}`], api: [] } });
      const leak = await engine.judge(b, ids, cfg, replays);
      expect(leak.verdict).toBe('LEAK_VISIBLE');
      const held = await engine.judge({ ...b, targets: { ui: ['{{item_url}}/safe'], api: [] } }, ids, cfg, replays);
      expect(held.verdict).toBe('HELD');
      expect(held.kaneRuns).toEqual([]); // the ratchet appends its replays itself
      expect(objectives.length).toBe(before);
    }, 60_000);

    it("judge(): the owner's control visit to the note comes before the viewer's request for it", async () => {
      const n = app.addNote(alice().email!, 'Order', `Order body ${alice().token}`);
      const own = app.addNote(byId(ids, 'bob').email!, 'Order', `Order body ${byId(ids, 'bob').token}`);
      const replays = [{ objective: 'replay', identity: 'alice', status: 'passed' as const, exitCode: 0, finalState: { item_url: `${app.url}/notes/${n.id}` }, creditsConsumed: 0, durationS: 0.5 }];
      const from = app.requests.length;
      await engine.judge(boundary({ id: 'ordered', targets: { ui: ['{{item_url}}/safe'], api: [] }, viewerOwn: { ui: [`${app.url}/notes/${own.id}`], api: [] } }), ids, cfg, replays);
      const log = app.requests.slice(from).filter((l) => l.includes(`/notes/${n.id}`));
      const firstAlice = log.findIndex((l) => l.startsWith(`${alice().email} `));
      const firstBob = log.findIndex((l) => l.startsWith(`${byId(ids, 'bob').email} `));
      expect(firstAlice).toBeGreaterThanOrEqual(0);
      expect(firstBob).toBeGreaterThan(firstAlice);
    }, 60_000);

    it('runBoundary on a locked boundary is judge-only: no authoring', async () => {
      const before = objectives.length;
      const r = await engine.runBoundary(boundary({ id: 'locked-b', locked: true, targets: { ui: [`${app.url}/notes`], api: [] } }), ids, cfg);
      expect(objectives.length).toBe(before);
      expect(['HELD', 'HARNESS_BROKEN']).toContain(r.verdict);
    }, 60_000);
  });

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
