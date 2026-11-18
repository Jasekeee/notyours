// Route tests for the Jotter demo (real HTTP via fetch, no Kane).
// They pin the demo's contract: the three seeded bugs are present, and guests are blocked.
// Run: npm run test:demo  (or: npx vitest run --root demo)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { openDb } from '../db.js';
import { DEFAULT_PASSWORDS, DEFAULT_TOKENS, loadTokens, seed } from '../seed.js';

const ALICE = { email: 'alice@jotter.test', password: DEFAULT_PASSWORDS.alice, token: DEFAULT_TOKENS.alice };
const BOB = { email: 'bob@jotter.test', password: DEFAULT_PASSWORDS.bob, token: DEFAULT_TOKENS.bob };

let server;
let base;

beforeAll(async () => {
  const db = await openDb(); // in-memory
  seed(db, { tokens: { ...DEFAULT_TOKENS }, passwords: { ...DEFAULT_PASSWORDS } });
  server = createApp(db).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

/** A tiny cookie-keeping client. Redirects are not followed so tests can assert on them. */
function client() {
  let cookie = '';
  return async function req(method, url, form) {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text() };
  };
}

async function loginAs(who) {
  const req = client();
  const res = await req('POST', '/login', { email: who.email, password: who.password });
  expect(res.status).toBe(302);
  return req;
}

describe('guests are blocked (no false alarms)', () => {
  const guest = client();

  it('GET /notes/1001 redirects to /login without the token', async () => {
    const res = await guest('GET', '/notes/1001');
    expect(res.status).toBe(302);
    expect(res.location).toBe('/login?next=%2Fnotes%2F1001');
    expect(res.text).not.toContain(ALICE.token);
  });

  it('GET /api/notes/1001 is 401 without the token', async () => {
    const res = await guest('GET', '/api/notes/1001');
    expect(res.status).toBe(401);
    expect(res.text).not.toContain(ALICE.token);
  });

  it('every private page redirects to /login', async () => {
    for (const url of ['/notes', '/notes/new', '/notes/1002', '/account', '/pro/export']) {
      const res = await guest('GET', url);
      expect(res.status, url).toBe(302);
      expect(res.location, url).toMatch(/^\/login\?next=/);
    }
  });

  it('POST /api/export is 401', async () => {
    const res = await guest('POST', '/api/export');
    expect(res.status).toBe(401);
  });
});

describe('positive controls', () => {
  it("Alice sees her own note 1001 with her token, in the page and the API", async () => {
    const alice = await loginAs(ALICE);
    const pageRes = await alice('GET', '/notes/1001');
    expect(pageRes.status).toBe(200);
    expect(pageRes.text).toContain(`Passport no. ${ALICE.token}`);
    const api = await alice('GET', '/api/notes/1001');
    expect(JSON.parse(api.text)).toMatchObject({ id: 1001, owner_email: ALICE.email, body: `Passport no. ${ALICE.token}` });
  });

  it("Bob's /notes lists only his note and /account shows his token in the bio", async () => {
    const bob = await loginAs(BOB);
    const list = await bob('GET', '/notes');
    expect(list.text).toContain('href="/notes/1002"');
    expect(list.text).toContain(BOB.token);
    expect(list.text).not.toContain('href="/notes/1001"');
    expect(list.text).not.toContain(ALICE.token);
    const account = await bob('GET', '/account');
    expect(account.text).toContain(BOB.token);
    expect(account.text).toContain('Jotter Free');
    expect(account.text).not.toContain(ALICE.token);
  });

  it('wrong password is rejected', async () => {
    const req = client();
    const res = await req('POST', '/login', { email: BOB.email, password: 'not-the-password' }); // notyours:allow-secret (fake test value)
    expect(res.status).toBe(401);
    expect(res.text).toContain('Wrong email or password');
  });
});

describe('seeded bugs are present', () => {
  it('SEEDED BUG #1: Bob can open Alice\'s note page /notes/1001', async () => {
    const bob = await loginAs(BOB);
    const res = await bob('GET', '/notes/1001');
    expect(res.status).toBe(200);
    expect(res.text).toContain(ALICE.token);
  });

  it('SEEDED BUG #2: Bob can fetch Alice\'s full record from /api/notes/1001', async () => {
    const bob = await loginAs(BOB);
    const res = await bob('GET', '/api/notes/1001');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ id: 1001, owner_id: 1, owner_email: ALICE.email });
    expect(res.text).toContain(ALICE.token);
  });

  it('SEEDED BUG #3: free Bob has no export button, but POST /api/export works anyway', async () => {
    const bob = await loginAs(BOB);
    const ui = await bob('GET', '/pro/export');
    expect(ui.status).toBe(200);
    expect(ui.text).not.toContain('action="/api/export"');
    expect(ui.text).toContain('Export is a Jotter Pro feature');

    const res = await bob('POST', '/api/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(res.headers.get('content-disposition')).toContain('jotter-export.txt');
    expect(res.text).toContain(BOB.token);
    expect(res.text).not.toContain(ALICE.token);
  });

  it('Pro Alice sees the export button and exports only her notes', async () => {
    const alice = await loginAs(ALICE);
    const ui = await alice('GET', '/pro/export');
    expect(ui.text).toContain('action="/api/export"');
    const res = await alice('POST', '/api/export');
    expect(res.text).toContain(ALICE.token);
    expect(res.text).not.toContain(BOB.token);
  });
});

describe('happy paths', () => {
  it('signup -> create note -> view it -> logout', async () => {
    const req = client();
    const signup = await req('POST', '/signup', { name: 'Carol', email: 'carol@jotter.test', password: 'carol-pass-123' }); // notyours:allow-secret (fake test value)
    expect(signup.status).toBe(302);
    expect(signup.location).toBe('/notes');

    const empty = await req('GET', '/notes');
    expect(empty.text).toContain('No notes yet');

    const created = await req('POST', '/notes/new', { title: 'Shopping', body: 'eggs & <milk>' });
    expect(created.status).toBe(302);
    const id = Number(created.location.split('/').pop());
    expect(id).toBeGreaterThan(1002);

    const view = await req('GET', created.location);
    expect(view.status).toBe(200);
    expect(view.text).toContain('eggs &amp; &lt;milk&gt;'); // escaped

    const account = await req('GET', '/account');
    expect(account.text).toContain('Jotter Free');

    const out = await req('GET', '/logout');
    expect(out.location).toBe('/login');
    expect((await req('GET', '/notes')).status).toBe(302);
  });

  it('login honours a safe ?next= and ignores an off-site one', async () => {
    const req = client();
    const ok = await req('POST', '/login?next=%2Faccount', { email: BOB.email, password: BOB.password });
    expect(ok.location).toBe('/account');
    const req2 = client();
    const evil = await req2('POST', '/login?next=%2F%2Fevil.test', { email: BOB.email, password: BOB.password });
    expect(evil.location).toBe('/notes');
  });

  it('duplicate signup and empty notes are rejected', async () => {
    const req = client();
    const dup = await req('POST', '/signup', { name: 'B', email: BOB.email, password: 'whatever-123' }); // notyours:allow-secret (fake test value)
    expect(dup.status).toBe(400);
    const bob = await loginAs(BOB);
    const bad = await bob('POST', '/notes/new', { title: '', body: '' });
    expect(bad.status).toBe(400);
  });

  it('unknown note ids are 404', async () => {
    const bob = await loginAs(BOB);
    expect((await bob('GET', '/notes/999999')).status).toBe(404);
    expect((await bob('GET', '/api/notes/abc')).status).toBe(404);
  });
});

describe('seed tokens', () => {
  it('reads tokens from identities.json (array or keyed object), ignoring invalid ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jotter-'));
    const arr = path.join(dir, 'arr.json');
    fs.writeFileSync(arr, JSON.stringify([{ id: 'alice', token: 'NY-ALICE-ABCDEFGHIJKL' }, { id: 'bob', token: 'bad' }]));
    expect(loadTokens([arr])).toEqual({ alice: 'NY-ALICE-ABCDEFGHIJKL', bob: DEFAULT_TOKENS.bob });

    const obj = path.join(dir, 'obj.json');
    fs.writeFileSync(obj, JSON.stringify({ bob: { token: 'NY-BOB-MNOPQRSTUVWX' } }));
    expect(loadTokens([path.join(dir, 'missing.json'), obj])).toEqual({ alice: DEFAULT_TOKENS.alice, bob: 'NY-BOB-MNOPQRSTUVWX' });

    expect(loadTokens([path.join(dir, 'missing.json')])).toEqual(DEFAULT_TOKENS);
    fs.rmSync(dir, { recursive: true });
  });

  it('default tokens match the notyours canary format', () => {
    expect(DEFAULT_TOKENS.alice).toMatch(/^NY-ALICE-[A-Z2-7]{12}$/);
    expect(DEFAULT_TOKENS.bob).toMatch(/^NY-BOB-[A-Z2-7]{12}$/);
  });
});
