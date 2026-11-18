import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TOKEN_RE } from '../../schemas.js';
import { DEFAULT_SPECS, byId, createIdentities, importUsers, loadIdentities, saveIdentities } from '../identities.js';

const stateDir = mkdtempSync(join(tmpdir(), 'ny-ids-'));
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

describe('identities', () => {
  it('creates Alice, Bob, a guest and a free user with tokens, ports and profiles', () => {
    const ids = createIdentities(DEFAULT_SPECS, { stateDir, basePort: 9401 });
    expect(ids.map((i) => [i.id, i.role, i.cdpPort])).toEqual([
      ['alice', 'owner', 9401], ['bob', 'viewer', 9402], ['guest', 'guest', 9403], ['free_user', 'free', 9404],
    ]);
    for (const i of ids) {
      expect(i.token).toMatch(TOKEN_RE);
      expect(i.token.startsWith(`NY-${i.id.toUpperCase()}-`)).toBe(true);
      expect(i.userDataDir).toBe(join(stateDir, 'profiles', i.id));
    }
    expect(byId(ids, 'guest').password).toBeUndefined();
    expect(byId(ids, 'guest').email).toBeUndefined();
    expect(byId(ids, 'alice').password).toMatch(/^Ny[a-z0-9]{16}7!$/);
    expect(() => byId(ids, 'nobody')).toThrow(/Unknown identity/);
  });

  it('persists passwords only to secrets.json (0600) and round-trips', () => {
    const ids = createIdentities(DEFAULT_SPECS, { stateDir });
    saveIdentities(stateDir, ids);
    const pub = readFileSync(join(stateDir, 'identities.json'), 'utf8');
    for (const i of ids) if (i.password) expect(pub).not.toContain(i.password);
    expect(pub).not.toContain('password');
    expect(statSync(join(stateDir, 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(loadIdentities(stateDir)).toEqual(ids);
  });

  it('imports users.json with role defaults and an added guest', () => {
    const file = join(stateDir, 'users.json');
    writeFileSync(file, JSON.stringify([
      { email: 'Alice.Smith@acme.test', password: 'a-pass' },
      { email: 'bob@acme.test', password: 'b-pass' },
      { id: 'carol', email: 'carol@acme.test', password: 'c-pass', role: 'pro', plan: 'pro' },
    ]));
    const ids = importUsers(file, { stateDir, basePort: 9501 });
    expect(ids.map((i) => [i.id, i.role, i.plan, i.email])).toEqual([
      ['alice_smith', 'owner', null, 'Alice.Smith@acme.test'],
      ['bob', 'viewer', null, 'bob@acme.test'],
      ['carol', 'pro', 'pro', 'carol@acme.test'],
      ['guest', 'guest', null, undefined],
    ]);
    expect(byId(ids, 'bob').password).toBe('b-pass');
  });

  it('rejects a malformed users file', () => {
    const file = join(stateDir, 'bad.json');
    writeFileSync(file, JSON.stringify([{ email: 'x@y.z' }]));
    expect(() => importUsers(file, { stateDir })).toThrow(/Invalid users file.*password/);
  });
});
