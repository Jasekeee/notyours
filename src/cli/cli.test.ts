import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { CommanderError } from 'commander';
import { ConfigSchema, IdentitySchema } from '../schemas.js';
import { mockBoundary, mockConfig } from '../mocks/fixtures.js';
import { buildProgram, type Actions } from './program.js';
import { checkHost } from './hosts.js';
import { runInit, parseUsersFile, readPublicIdentities } from './init.js';
import { assertHostsAllowed, boundaryUrls, ensureCredits, exitCodeFor, runHook } from './commands.js';
import { checkNode, runDoctor } from './doctor.js';
import type { Exec } from './system.js';
import { guard, mergeHookSettings } from './hooks.js';
import { matchesGlob } from './glob.js';
import { assertNoSymlinks, safeWriteFile } from './safe-fs.js';
import { copyFilter, demoStartCommand, packagedDemoDir } from './demo.js';
import { UserError } from './workspace.js';
import { isOwnedHost, ownedStorePath, recordOwnedHosts, setOwnedStorePathForTests } from './owned.js';
import { mockHeldResult, mockLeakResult } from '../mocks/fixtures.js';

const tmp = (p = 'ny-cli-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
// Never touch the real ~/.config/notyours from tests.
const TEST_STORE = path.join(tmp('ny-home-'), 'owned-hosts.json');
setOwnedStorePathForTests(TEST_STORE);

// ---------- argument parsing ----------

type Call = [string, ...unknown[]];

function harness() {
  const calls: Call[] = [];
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return 0;
    };
  const actions: Actions = {
    doctor: rec('doctor'),
    init: rec('init'),
    map: rec('map'),
    run: rec('run'),
    lock: rec('lock'),
    replay: rec('replay'),
    report: rec('report'),
    demo: rec('demo'),
    installHooks: rec('installHooks'),
    hook: rec('hook'),
  };
  const codes: number[] = [];
  const parse = (...argv: string[]) => buildProgram(actions, { testing: true, onExit: (c) => codes.push(c) }).parseAsync(['node', 'notyours', ...argv]);
  return { calls, codes, parse };
}

describe('argument parsing', () => {
  const cwd = process.cwd();

  it('doctor and map take no arguments; -C sets the project dir', async () => {
    const h = harness();
    await h.parse('doctor');
    await h.parse('-C', '/tmp/app', 'map');
    expect(h.calls).toEqual([
      ['doctor', { cwd }],
      ['map', { cwd: '/tmp/app' }],
    ]);
    expect(h.codes).toEqual([0, 0]);
  });

  it('init: --url required, --users, repeatable --allow-host, --i-own-this', async () => {
    const h = harness();
    await h.parse('init', '--url', 'http://localhost:3000');
    await h.parse('init', '--url', 'https://staging.acme.dev', '--users', 'u.yaml', '--allow-host', 'staging.acme.dev', '--allow-host', 'api.acme.dev', '--i-own-this');
    expect(h.calls[0]).toEqual(['init', { cwd, url: 'http://localhost:3000', users: undefined, allowHost: [], iOwnThis: false }]);
    expect(h.calls[1]).toEqual([
      'init',
      { cwd, url: 'https://staging.acme.dev', users: 'u.yaml', allowHost: ['staging.acme.dev', 'api.acme.dev'], iOwnThis: true },
    ]);
    await expect(h.parse('init')).rejects.toThrow(CommanderError);
  });

  it('run / lock / replay take variadic boundary ids', async () => {
    const h = harness();
    await h.parse('run');
    await h.parse('run', 'a', 'b', '--dry-run');
    await h.parse('lock', 'a', '--reauthor');
    await h.parse('lock');
    await h.parse('replay', 'x', 'y', 'z');
    expect(h.calls).toEqual([
      ['run', [], { cwd, dryRun: false }],
      ['run', ['a', 'b'], { cwd, dryRun: true }],
      ['lock', ['a'], { cwd, reauthor: true }],
      ['lock', [], { cwd, reauthor: false }],
      ['replay', ['x', 'y', 'z'], { cwd }],
    ]);
  });

  it('report --open, demo --dir / --no-open', async () => {
    const h = harness();
    await h.parse('report');
    await h.parse('report', '--open');
    await h.parse('demo');
    await h.parse('demo', '--dir', 'work', '--no-open');
    expect(h.calls).toEqual([
      ['report', { cwd, open: false }],
      ['report', { cwd, open: true }],
      ['demo', { cwd, dir: undefined, open: true }],
      ['demo', { cwd, dir: 'work', open: false }],
    ]);
  });

  it('install-hooks --cli and hook <event> with fixed choices', async () => {
    const h = harness();
    await h.parse('install-hooks');
    await h.parse('install-hooks', '--cli', 'node ./node_modules/notyours/dist/cli/index.js');
    await h.parse('hook', 'guard');
    await h.parse('hook', 'post-tool');
    await h.parse('hook', 'stop');
    expect(h.calls).toEqual([
      ['installHooks', { cwd, cli: 'npx notyours' }],
      ['installHooks', { cwd, cli: 'node ./node_modules/notyours/dist/cli/index.js' }],
      ['hook', 'guard', { cwd }],
      ['hook', 'post-tool', { cwd }],
      ['hook', 'stop', { cwd }],
    ]);
    await expect(h.parse('hook', 'pre-tool')).rejects.toThrow(/Allowed choices are post-tool, guard, stop/);
    await expect(h.parse('hook')).rejects.toThrow(CommanderError);
  });

  it('rejects unknown commands and options', async () => {
    const h = harness();
    await expect(h.parse('probe')).rejects.toThrow(CommanderError);
    await expect(h.parse('run', '--force')).rejects.toThrow(/unknown option/);
    expect(h.calls).toEqual([]);
  });

  it('passes the handler exit code through', async () => {
    const codes: number[] = [];
    const actions = { run: async () => 1 } as unknown as Actions;
    await buildProgram(actions, { testing: true, onExit: (c) => codes.push(c) }).parseAsync(['node', 'notyours', 'run']);
    expect(codes).toEqual([1]);
  });
});

// ---------- allowHosts ----------

describe('allowHosts', () => {
  it('accepts METHOD-prefixed api targets (CC-2) and still checks their host', () => {
    const local = ConfigSchema.parse({ baseUrl: 'http://127.0.0.1:3077' });
    const b3 = { ...mockBoundary, id: 'b3', targets: { ui: ['http://127.0.0.1:3077/pro/export'], api: ['POST http://127.0.0.1:3077/api/export'] } };
    expect(() => assertHostsAllowed(local, [b3], tmp('ny-m-'))).not.toThrow();
    const evil = { ...b3, targets: { ui: [], api: ['POST https://victim.example.org/api/export'] } };
    expect(() => assertHostsAllowed(local, [evil], tmp('ny-m-'))).toThrow(/victim\.example\.org/);
    const uiMethod = { ...b3, targets: { ui: ['POST http://127.0.0.1:3077/x'], api: [] } };
    expect(() => assertHostsAllowed(local, [uiMethod], tmp('ny-m-'))).toThrow(/must be an absolute http/);
  });

  const local = ['localhost', '127.0.0.1'];

  it('allows localhost and 127.0.0.1 by default', () => {
    expect(checkHost('http://localhost:3000', local, false).ok).toBe(true);
    expect(checkHost('http://127.0.0.1:3077/x', local, false).ok).toBe(true);
  });

  it('refuses any host outside allowHosts, even with --i-own-this', () => {
    const r = checkHost('https://app.acme.dev', local, true);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not in allowHosts.*--allow-host app\.acme\.dev --i-own-this/s);
    expect(checkHost('http://0.0.0.0:3000', local, true).ok).toBe(false);
    expect(checkHost('http://localhost.evil.dev', local, true).ok).toBe(false);
  });

  it('a non-local host in allowHosts still needs --i-own-this', () => {
    const hosts = [...local, 'staging.acme.dev'];
    expect(checkHost('https://staging.acme.dev', hosts, false)).toMatchObject({ ok: false, reason: expect.stringMatching(/--i-own-this/) });
    expect(checkHost('https://STAGING.acme.dev/x', hosts, true).ok).toBe(true);
  });

  it('rejects non-http URLs', () => {
    expect(() => checkHost('ftp://localhost', local, false)).toThrow(/http/);
    expect(() => checkHost('not a url', local, false)).toThrow(/valid URL/);
  });

  describe('init', () => {
    it('refuses a remote host and writes nothing', () => {
      const root = tmp();
      expect(() => runInit(root, { url: 'https://acme.dev' })).toThrow(UserError);
      expect(() => runInit(root, { url: 'https://acme.dev', allowHost: ['acme.dev'] })).toThrow(/--i-own-this/);
      expect(() => runInit(root, { url: 'https://acme.dev', iOwnThis: true })).toThrow(/not in allowHosts/);
      expect(fs.existsSync(path.join(root, '.notyours'))).toBe(false);
    });

    it('accepts a remote host with --allow-host and --i-own-this, and remembers it', () => {
      const root = tmp();
      const r = runInit(root, { url: 'https://acme.dev', allowHost: ['ACME.dev'], iOwnThis: true });
      expect(r.allowHosts).toEqual(['localhost', '127.0.0.1', 'acme.dev']);
      const cfg = ConfigSchema.parse(YAML.parse(fs.readFileSync(path.join(root, '.notyours/config.yaml'), 'utf8')));
      expect(cfg).toMatchObject({ baseUrl: 'https://acme.dev', allowHosts: ['localhost', '127.0.0.1', 'acme.dev'] });
      // Re-init keeps allowHosts but still needs --i-own-this for the remote host.
      expect(() => runInit(root, { url: 'https://acme.dev' })).toThrow(/--i-own-this/);
    });

    it('localhost: default identities with valid tokens, 0600 secrets, stable tokens on re-init', () => {
      const root = tmp();
      const a = runInit(root, { url: 'http://localhost:3000' });
      expect(a.identities.map((i) => i.id)).toEqual(['alice', 'bob', 'guest', 'free_user']);
      for (const i of a.identities) expect(() => IdentitySchema.parse(i)).not.toThrow();
      expect(new Set(a.identities.map((i) => i.cdpPort)).size).toBe(4);
      expect(fs.statSync(path.join(root, '.notyours/secrets.json')).mode & 0o777).toBe(0o600);
      const b = runInit(root, { url: 'http://localhost:3001' }, a.identities);
      expect(b.identities.map((i) => i.token)).toEqual(a.identities.map((i) => i.token));
    });

    it('--users: list or {users}, passwordEnv, errors never echo values', () => {
      const root = tmp();
      const f = path.join(root, 'users.yaml');
      fs.writeFileSync(f, 'users:\n  - { id: alice, role: owner, email: a@x.test, passwordEnv: NY_TEST_PW }\n  - { id: bob, role: viewer }\n');
      expect(() => runInit(root, { url: 'http://localhost:3000', users: f })).toThrow(/NY_TEST_PW is not set/);
      process.env.NY_TEST_PW = 'from-env'; // notyours:allow-secret (fake)
      try {
        const r = runInit(root, { url: 'http://localhost:3000', users: f });
        expect(r.identities[0]).toMatchObject({ id: 'alice', password: 'from-env', plan: 'free' }); // notyours:allow-secret (fake)
      } finally {
        delete process.env.NY_TEST_PW;
      }
      fs.writeFileSync(f, '[{ id: Alice, role: owner, password: hunter2-secret }]');
      expect(() => parseUsersFile(f)).toThrow(/0\.id/);
      try {
        parseUsersFile(f);
      } catch (e) {
        expect((e as Error).message).not.toContain('hunter2');
      }
    });
  });

  it('run refuses boundaries that point Kane at hosts outside allowHosts (fails closed)', () => {
    const root = tmp();
    const ok = (b: typeof mockBoundary, cfg = mockConfig) => () => assertHostsAllowed(cfg, [b], root);
    expect(ok(mockBoundary)).not.toThrow();
    expect(ok({ ...mockBoundary, targets: { ui: ['https://evil.dev/notes/{{id}}'], api: [] } })).toThrow(/evil\.dev.*not in allowHosts/);
    expect(ok({ ...mockBoundary, create: { ...mockBoundary.create, objective: 'Open https://evil.dev and add {{token}}' } })).toThrow(/evil\.dev/);
    expect(ok({ ...mockBoundary, create: { ...mockBoundary.create, objective: 'Go to evil.dev/notes and add {{token}}' } })).toThrow(/evil\.dev/);
    expect(ok({ ...mockBoundary, targets: { ui: ['http://{{host}}/notes'], api: [] } })).toThrow(/template/);
    expect(ok({ ...mockBoundary, targets: { ui: ['http://[bad/x'], api: [] } })).toThrow(/parse/);
    expect(ok({ ...mockBoundary, targets: { ui: ['evil.dev/x'], api: [] } })).toThrow(/absolute http/);
    expect(() => assertHostsAllowed({ ...mockConfig, baseUrl: 'https://evil.dev' }, [], root)).toThrow(/baseUrl/);
    expect(boundaryUrls({ ...mockBoundary, targets: { ui: ['{{note_url}}'], api: [] } })).toEqual(['http://127.0.0.1:3000/notes/new', 'http://127.0.0.1/']);
  });

  it('targets: only {{stored}} optionally followed by a path; objectives are scanned deny-by-default', () => {
    const root = tmp();
    const t = (ui: string) => () => assertHostsAllowed(mockConfig, [{ ...mockBoundary, targets: { ui: [ui], api: [] } }], root);
    expect(t('{{note_url}}')).not.toThrow();
    expect(t('{{note_url}}/edit?x=1')).not.toThrow();
    expect(t('{{sub}}.evil.dev/x')).toThrow(/must be an absolute/);
    expect(t('{{a}}{{b}}')).toThrow(/must be an absolute/);
    const o = (objective: string) => () => assertHostsAllowed(mockConfig, [{ ...mockBoundary, create: { ...mockBoundary.create, objective } }], root);
    expect(o('Go to evil.dev and add {{token}}')).toThrow(/evil\.dev/);
    expect(o('Open https:/evil.dev/notes, add {{token}}')).toThrow(/evil\.dev/);
    expect(o('Go to 10.0.0.5:8080/admin')).toThrow(/10\.0\.0\.5/);
    expect(o('Sign in as alice@demo.test, open http://localhost:3000/index.html, add {{token}}')).not.toThrow();
    expect(o('Download notes from evil.zip and add {{token}}')).toThrow(/evil\.zip/);
    expect(o('Go to evil\uFF0Edev and add {{token}}')).toThrow(/evil\.dev/);
    expect(o('Go to \uFF45\uFF56\uFF49\uFF4C\uFF0E\uFF44\uFF45\uFF56/x and add {{token}}')).toThrow(/evil\.dev/); // fullwidth letters
    expect(o('Go to bücher.example and add {{token}}')).toThrow(/xn--bcher-kva\.example/);
    expect(t('http://\uFF45vil.dev/x')).toThrow(/evil\.dev/);
    expect(t('http://localhost:3000@evil.dev/x')).toThrow(/evil\.dev|credentials/);
    expect(t('http://user:pw@localhost:3000/x')).toThrow(/credentials/);
    expect(t('http://localhost:3000/a b')).toThrow(/must be an absolute/);
    expect(t('http://localhost:3000\\@evil.dev/')).toThrow(/must be an absolute/);
  });

  it('the owned-hosts store has a fixed location and ignores files writable by others', () => {
    setOwnedStorePathForTests(undefined);
    const realHome = os.userInfo().homedir;
    const savedHome = process.env.HOME;
    process.env.NOTYOURS_HOME = '/tmp/fake';
    process.env.HOME = '/tmp/fake-home';
    process.env.XDG_CONFIG_HOME = '/tmp/fake-xdg';
    try {
      expect(ownedStorePath()).toBe(path.join(realHome, '.config/notyours/owned-hosts.json'));
    } finally {
      delete process.env.NOTYOURS_HOME;
      delete process.env.XDG_CONFIG_HOME;
      process.env.HOME = savedHome;
      setOwnedStorePathForTests(TEST_STORE);
    }
    const root = tmp();
    recordOwnedHosts(root, ['acme.dev']);
    expect(isOwnedHost(root, 'acme.dev')).toBe(true);
    fs.chmodSync(TEST_STORE, 0o666);
    expect(isOwnedHost(root, 'acme.dev')).toBe(false);
    fs.chmodSync(TEST_STORE, 0o600);
  });

  it('a non-local host in a (possibly cloned) config.yaml is refused until confirmed on this machine', () => {
    const root = tmp();
    const cfg = ConfigSchema.parse({ baseUrl: 'https://acme.dev', allowHosts: ['localhost', 'acme.dev'] });
    const b = { ...mockBoundary, create: { ...mockBoundary.create, objective: 'Go to https://acme.dev/notes/new, add {{token}}' }, targets: { ui: ['{{note_url}}'], api: [] } };
    expect(() => assertHostsAllowed(cfg, [b], root)).toThrow(/hasn't been confirmed on this machine.*--i-own-this/);
    runInit(root, { url: 'https://acme.dev', allowHost: ['acme.dev'], iOwnThis: true });
    expect(() => assertHostsAllowed(cfg, [b], root)).not.toThrow();
    expect(() => assertHostsAllowed(cfg, [b], tmp())).toThrow(/confirmed/); // another project: not confirmed
  });
});

// ---------- credits, exit codes, doctor ----------

describe('credits and exit codes', () => {
  it('refuses authoring below creditFloor; unknown balance is an error', async () => {
    await expect(ensureCredits(mockConfig, 1, async () => 299)).rejects.toThrow(/below creditFloor 300/);
    await expect(ensureCredits(mockConfig, 1, async () => undefined)).rejects.toThrow(/notyours doctor/);
    await expect(ensureCredits(mockConfig, 1, async () => 5000)).resolves.toBeUndefined();
  });

  it('uses the real engine and ratchet (no NOTYOURS_REAL switch); constructing them starts nothing', async () => {
    const { getEngine, getRatchet } = await import('./backends.js');
    const { KaneEngine } = await import('../engine/index.js');
    const { RealRatchet } = await import('../ratchet/index.js');
    expect(getEngine('/tmp/p')).toBeInstanceOf(KaneEngine);
    expect(getRatchet('/tmp/p')).toBeInstanceOf(RealRatchet);
  });

  it('exit 1 on any leak or harness failure', () => {
    expect(exitCodeFor([mockHeldResult])).toBe(0);
    expect(exitCodeFor([mockHeldResult, mockLeakResult])).toBe(1);
    expect(exitCodeFor([{ ...mockHeldResult, verdict: 'HARNESS_BROKEN' }])).toBe(1);
  });
});

describe('doctor', () => {
  it('Node < 22 fails with an upgrade hint', () => {
    expect(checkNode('22.0.0').status).toBe('ok');
    const c = checkNode('20.11.1');
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/Node 20\.11\.1 found; notyours requires Node 22\+\. Upgrade: `nvm install 22`/);
  });

  const fakeExec =
    (out: Record<string, { exitCode?: number; stdout?: string; notFound?: boolean }>): Exec =>
    async (_f, args) => {
      const r = out[args[0]!] ?? {};
      return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: '', notFound: r.notFound ?? false };
    };

  it('all green', async () => {
    const checks = await runDoctor(300, {
      exec: fakeExec({ whoami: { stdout: '│  ✓ Authenticated  │' }, balance: { stdout: 'Available credits: 11121.8322' } }),
      findChrome: () => '/chrome',
      isPortFree: async () => true,
      nodeVersion: '22.3.0',
    });
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ['Node', 'ok'],
      ['Chrome', 'ok'],
      ['kane-cli login', 'ok'],
      ['Kane credits', 'ok'],
      ['Port 3077', 'ok'],
    ]);
  });

  it('missing kane-cli, no Chrome, low credits, busy port', async () => {
    const missing = await runDoctor(300, { exec: fakeExec({ whoami: { notFound: true } }), findChrome: () => undefined, isPortFree: async () => false, nodeVersion: '22.3.0' });
    expect(missing.map((c) => [c.name, c.status])).toEqual([
      ['Node', 'ok'],
      ['Chrome', 'fail'],
      ['kane-cli', 'fail'],
      ['Port 3077', 'fail'],
    ]);
    const low = await runDoctor(300, {
      exec: fakeExec({ whoami: { stdout: 'Authenticated' }, balance: { stdout: 'Available credits: 120' } }),
      findChrome: () => '/chrome',
      isPortFree: async () => true,
      nodeVersion: '22.3.0',
    });
    expect(low.find((c) => c.name === 'Kane credits')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/120 left, below creditFloor 300/) });
    const unauth = await runDoctor(300, { exec: fakeExec({ whoami: { exitCode: 1, stdout: 'Not authenticated' } }), findChrome: () => '/c', isPortFree: async () => true, nodeVersion: '22.3.0' });
    expect(unauth.find((c) => c.name === 'kane-cli login')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/kane-cli login/) });
  });
});

// ---------- hooks ----------

function hookProject() {
  const root = tmp('ny-hook-');
  runInit(root, { url: 'http://localhost:3000' });
  const bdir = path.join(root, '.notyours/boundaries');
  fs.writeFileSync(path.join(bdir, 'notes.yaml'), YAML.stringify({ ...mockBoundary, id: 'notes', surface: ['src/notes/**', 'src/app/notes/[id]/page.tsx'], locked: true }));
  fs.writeFileSync(path.join(bdir, 'invoices.yaml'), YAML.stringify({ ...mockBoundary, id: 'invoices', surface: ['src/invoices.ts'] }));
  return root;
}

describe('hooks', () => {
  const root = hookProject();
  const g = (tool_name: string, tool_input: Record<string, unknown>) => guard({ tool_name, tool_input }, root);

  it('guard: secrets and profiles are off limits for read and write', () => {
    expect(g('Read', { file_path: path.join(root, '.notyours/secrets.json') }).allow).toBe(false);
    expect(g('Grep', { pattern: 'x', path: '.notyours/profiles/alice' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat .notyours/secrets.json | jq' }).allow).toBe(false);
  });

  it('guard: locked boundaries, recordings, results and config are read-only', () => {
    expect(g('Edit', { file_path: '.notyours/boundaries/notes.yaml' }).allow).toBe(false);
    expect(g('Write', { file_path: path.join(root, '.testmuai/tests/notes_test.md') }).allow).toBe(false);
    expect(g('Write', { file_path: '.notyours/runs/x/results.json' }).allow).toBe(false);
    expect(g('Edit', { file_path: '.notyours/config.yaml' }).allow).toBe(false);
    expect(g('Bash', { command: "sed -i '' 's/locked: true//' .notyours/boundaries/notes.yaml" }).allow).toBe(false);
    expect(g('Bash', { command: 'rm -rf .testmuai/tests' }).allow).toBe(false);
    expect(g('Bash', { command: 'echo {} > .notyours/runs/latest.json' }).allow).toBe(false);
  });

  it('guard: case, symlink and directory tricks do not reach the secrets', () => {
    expect(g('Read', { file_path: '.NOTYOURS/Secrets.json' }).allow).toBe(false);
    expect(g('Read', { file_path: 'src/../.notyours/./secrets.json' }).allow).toBe(false);
    fs.symlinkSync(path.join(root, '.notyours'), path.join(root, 'innocent'));
    expect(g('Read', { file_path: 'innocent/secrets.json' }).allow).toBe(false);
    expect(g('Grep', { pattern: 'password', path: '.notyours' }).allow).toBe(false);
    expect(g('Glob', { pattern: '**', path: path.join(root, '.notyours/') }).allow).toBe(false);
    expect(g('Grep', { pattern: 'x', path: '.notyours/boundaries' }).allow).toBe(true);
    expect(g('Bash', { command: 'cat .notyours/S*' }).allow).toBe(false);
    expect(g('Bash', { command: 'grep -r pass .notyours' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat .NOTYOURS/SECRETS.JSON' }).allow).toBe(false);
    expect(g('Bash', { command: 'ls .notyours/boundaries/*.yaml' }).allow).toBe(false); // use the Glob tool instead
    expect(g('Bash', { command: 'cat .notyours/*' }).allow).toBe(false);
    expect(g('Write', { file_path: TEST_STORE }).allow).toBe(false);
    expect(g('Bash', { command: 'echo {} > ~/.config/notyours/owned-hosts.json' }).allow).toBe(false);
  });

  it('guard: Bash on protected folders is allowlisted read-only; hook config is read-only', () => {
    expect(g('Bash', { command: "cat .notyours/se'cr'ets.json" }).allow).toBe(false);
    expect(g('Bash', { command: 'cat .notyours/se\\crets.json' }).allow).toBe(false);
    expect(g('Bash', { command: "python3 -c \"open('.testmuai/tests/x_test.md','w')\"" }).allow).toBe(false);
    expect(g('Bash', { command: 'node scripts/x.js .testmuai/tests' }).allow).toBe(false);
    expect(g('Bash', { command: 'cd .notyours && rm -rf runs' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat .notyours/runs/latest.json > /tmp/x' }).allow).toBe(false);
    expect(g('Bash', { command: 'find .testmuai -exec rm {} +' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat .notyours/$(echo c2VjcmV0cy5qc29u | base64 -d)' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat .notyours/`printf s`ecrets.json' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat .notyours/boundaries/../profiles/x' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat ~/proj/.notyours/runs/latest.json' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat .n*/secrets.json' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat ./.no?yours/s?crets.json' }).allow).toBe(false);
    expect(g('Bash', { command: 'cp x .{t,x}estmuai/tests/' }).allow).toBe(false);
    expect(g('Bash', { command: "yq -i '.locked=false' .notyours/boundaries/notes.yaml" }).allow).toBe(false);
    expect(g('Bash', { command: 'rg --pre ./x.sh foo .notyours/boundaries' }).allow).toBe(false);
    expect(g('Bash', { command: 'git diff --output=.testmuai/tests/x .' }).allow).toBe(false);
    expect(g('Bash', { command: 'ls src/*.ts' }).allow).toBe(true);
    expect(g('Bash', { command: 'cat x>.n*' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat ".n"*/runs/latest.json' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat a:.t?stmuai/tests/x' }).allow).toBe(false);
    expect(g('Bash', { command: 'cp x {.,y}testmuai' }).allow).toBe(false);
    expect(g('Bash', { command: "jq '.items[0]' package.json" }).allow).toBe(true);
    expect(g('Bash', { command: "awk '{print $1}' src/a.ts" }).allow).toBe(true);
    expect(g('Bash', { command: 'HOME=/tmp/fake npx notyours run' }).allow).toBe(false);
    expect(g('Bash', { command: 'XDG_CONFIG_HOME=/tmp/x notyours replay' }).allow).toBe(false);
    expect(g('Bash', { command: 'env -i PATH=$PATH npx notyours run' }).allow).toBe(false);
    expect(g('Bash', { command: 'jq . .notyours/runs/latest.json | head' }).allow).toBe(true);
    expect(g('Bash', { command: 'npm test && npx notyours replay notes' }).allow).toBe(true);
    expect(g('Bash', { command: 'npx notyours run --dry-run' }).allow).toBe(true);
    expect(g('Edit', { file_path: '.claude/settings.json' }).allow).toBe(false);
    expect(g('Write', { file_path: '.claude/settings.local.json' }).allow).toBe(false);
    expect(g('Edit', { file_path: '.claude/commands/notyours-map.md' }).allow).toBe(false);
    expect(g('Bash', { command: "sed -i '' '/guard/d' .claude/settings.json" }).allow).toBe(false);
  });

  it('guard: self-approving a new host is blocked', () => {
    expect(g('Bash', { command: 'npx notyours init --url https://x.dev --allow-host x.dev --i-own-this' }).allow).toBe(false);
  });

  it('guard: recorded logins (they hold the typed password) are off limits like secrets.json', () => {
    expect(g('Read', { file_path: '.notyours/tests/login_alice_test.md' }).allow).toBe(false);
    expect(g('Read', { file_path: '.notyours/tests/output-login_alice/.internal/meta.json' }).allow).toBe(false);
    expect(g('Grep', { path: '.notyours/tests' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat .notyours/tests/login_bob_test.md' }).allow).toBe(false);
    expect(g('Read', { file_path: '.notyours/tests/b1-notes-cross-user_bob_test.md' }).allow).toBe(true);
    expect(g('Read', { file_path: '.testmuai/tests/login_alice_test.md' }).allow).toBe(false); // before adoption
    expect(g('Bash', { command: 'grep -r value .notyours/tests/output-log*' }).allow).toBe(false);
    expect(g('Bash', { command: 'cat .notyours/profiles/alice/notyours-login/login_alice_test.md' }).allow).toBe(false);
  });

  it('guard: normal work is allowed (app code, unlocked boundaries, drafts, reading the oracle)', () => {
    expect(g('Edit', { file_path: 'src/notes/route.ts' }).allow).toBe(true);
    expect(g('Edit', { file_path: '.notyours/boundaries/invoices.yaml' }).allow).toBe(true);
    expect(g('Write', { file_path: '.notyours/boundaries/new-thing.yaml' }).allow).toBe(true);
    expect(g('Read', { file_path: '.notyours/boundaries/notes.yaml' }).allow).toBe(true);
    expect(g('Read', { file_path: '.testmuai/tests/notes_test.md' }).allow).toBe(true);
    expect(g('Bash', { command: 'ls .testmuai/tests && cat .notyours/runs/latest.json' }).allow).toBe(true);
    expect(g('Bash', { command: 'npx notyours replay notes' }).allow).toBe(true);
    expect(g('Edit', { file_path: '/elsewhere/file.ts' }).allow).toBe(true);
  });

  it('post-tool (ratchet hook) records the edited file and matched globs per boundary in dirty.json', async () => {
    const r = await runHook('post-tool', { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/app/notes/[id]/page.tsx') } }, root);
    expect(r.exitCode).toBe(0);
    await runHook('post-tool', { tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/invoices.ts') } }, root);
    const dirty = JSON.parse(fs.readFileSync(path.join(root, '.notyours', 'dirty.json'), 'utf8')) as Record<string, { files: string[] }>;
    expect(Object.keys(dirty).sort()).toEqual(['invoices', 'notes']);
    expect(dirty.notes!.files.join(' ')).toMatch(/src\/app\/notes\/\[id\]\/page\.tsx/);
    expect((await runHook('post-tool', { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'README.md') } }, root)).exitCode).toBe(0);
  });

  it('stop (ratchet hook): unlocked dirty boundaries never trigger Kane; the human is told', async () => {
    const r = await runHook('stop', {}, root);
    expect(r.exitCode).toBe(0); // nothing locked, so nothing replayed and nothing blocked
    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toMatch(/invoices|notes/);
  });

  it('stop refuses to replay a dirty locked boundary pointing outside allowHosts, also in a nested app folder', async () => {
    for (const nested of [false, true]) {
      const r2 = tmp('ny-gate-');
      const app = nested ? path.join(r2, 'apps', 'web') : r2;
      fs.mkdirSync(app, { recursive: true });
      runInit(app, { url: 'http://localhost:3000' });
      fs.writeFileSync(path.join(app, '.notyours/boundaries/evil.yaml'), YAML.stringify({ ...mockBoundary, id: 'evil', locked: true, surface: ['src/**'], targets: { ui: ['https://victim.example.org/notes/1'], api: [] } }));
      fs.writeFileSync(path.join(app, '.notyours/dirty.json'), JSON.stringify({ evil: { files: ['src/a.ts'], globs: ['src/**'], ts: new Date().toISOString() } }));
      const r = await runHook('stop', {}, r2);
      expect(r.exitCode).toBe(0); // never blocks, never replays
      expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toMatch(/victim\.example\.org.*not in allowHosts/);
    }
  });

  it('init never takes a profile path from a committed identities.json', () => {
    const r3 = tmp('ny-ids-');
    fs.mkdirSync(path.join(r3, '.notyours'), { recursive: true });
    fs.writeFileSync(path.join(r3, '.notyours/identities.json'), JSON.stringify([
      { id: 'alice', role: 'owner', plan: 'pro', token: 'NY-ALICE-JOTTERSEED2A', cdpPort: 9301, userDataDir: '/Users/someone/Library/Application Support/Google/Chrome' },
    ]));
    const ids = readPublicIdentities(r3);
    expect(ids[0]!.token).toBe('NY-ALICE-JOTTERSEED2A');
    expect(ids[0]!.userDataDir).toBe(path.join(r3, '.notyours', 'profiles', 'alice'));
  });

  it('install-hooks merges idempotently and keeps the user\'s own hooks', () => {
    const mine = { hooks: { Stop: [{ hooks: [{ type: 'command' as const, command: 'echo mine' }] }] }, permissions: { allow: ['Bash(ls)'] } };
    const once = mergeHookSettings(mine, 'npx notyours');
    const twice = mergeHookSettings(once, 'node dist/cli/index.js');
    expect(twice.hooks!.Stop!.map((x) => x.hooks[0]!.command)).toEqual(['echo mine', 'node dist/cli/index.js hook stop']);
    expect(twice.hooks!.PreToolUse).toHaveLength(1);
    expect(twice.hooks!.PreToolUse![0]!.hooks[0]!.command).toBe('node dist/cli/index.js hook guard');
    expect(twice.hooks!.PostToolUse![0]!.matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect((twice.permissions as { deny: string[]; allow: string[] }).deny).toContain('Read(./.notyours/secrets.json)');
    expect((twice.permissions as { allow: string[] }).allow).toEqual(['Bash(ls)']);
    expect(new Set((twice.permissions as { deny: string[] }).deny).size).toBe((twice.permissions as { deny: string[] }).deny.length);
  });
});

describe('glob', () => {
  it('matches surface globs', () => {
    expect(matchesGlob('src/app/api/notes/route.ts', 'src/app/api/notes/**')).toBe(true);
    expect(matchesGlob('src/app/api/notes', 'src/app/api/notes/**')).toBe(true);
    expect(matchesGlob('src/app/api/notesx/a.ts', 'src/app/api/notes/**')).toBe(false);
    expect(matchesGlob('src/a/b/c.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/c.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/a/c.ts', 'src/*.ts')).toBe(false);
    expect(matchesGlob('app/notes/[id]/page.tsx', 'app/notes/[id]/**')).toBe(true);
    expect(matchesGlob('src/routes/notes.ts', 'src/routes')).toBe(true);
    expect(matchesGlob('./server.js', 'server.js')).toBe(true);
  });
});

describe('safe-fs', () => {
  it('tightens the mode of an existing file and refuses symlinks', () => {
    const root = tmp();
    const f = path.join(root, '.notyours/secrets.json');
    fs.mkdirSync(path.dirname(f));
    fs.writeFileSync(f, '{}', { mode: 0o644 });
    safeWriteFile(root, f, '{"identities":[]}', { mode: 0o600 });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    fs.symlinkSync(os.tmpdir(), path.join(root, 'link'));
    expect(() => assertNoSymlinks(root, path.join(root, 'link/x'))).toThrow(/symlink/);
    expect(() => assertNoSymlinks(root, path.join(root, '../outside'))).toThrow(/outside the project/);
  });
});

describe('demo helpers', () => {
  it('copy filter skips deps, secrets and run state but keeps app code and recordings', () => {
    expect(copyFilter('/d/node_modules')).toBe(false);
    expect(copyFilter('/d/.notyours/secrets.json')).toBe(false);
    expect(copyFilter('/d/.notyours/runs')).toBe(false);
    expect(copyFilter('/d/.testmuai/evidence')).toBe(false);
    expect(copyFilter('/d/.testmuai/tests')).toBe(true);
    expect(copyFilter('/d/.notyours/boundaries')).toBe(true);
    expect(copyFilter('/d/src/runs')).toBe(true);
  });

  it('finds how to start the demo', () => {
    const d = tmp();
    expect(() => demoStartCommand(d)).toThrow(/start/);
    fs.writeFileSync(path.join(d, 'server.js'), '');
    expect(demoStartCommand(d)).toEqual({ cmd: process.execPath, args: ['server.js'] });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }));
    expect(demoStartCommand(d).args).toEqual(['run', '--silent', 'start']);
  });

  it('packagedDemoDir ignores an empty demo/ (only .gitkeep)', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'demo'));
    fs.writeFileSync(path.join(d, 'demo/.gitkeep'), '');
    fs.mkdirSync(path.join(d, 'dist/cli'), { recursive: true });
    expect(packagedDemoDir(path.join(d, 'dist'), {})).toBeUndefined();
    fs.writeFileSync(path.join(d, 'demo/server.js'), '');
    expect(packagedDemoDir(path.join(d, 'dist'), {})).toBe(path.join(d, 'demo'));
    expect(packagedDemoDir(path.join(d, 'src/cli'), {})).toBe(path.join(d, 'demo'));
    expect(packagedDemoDir(path.join(d, 'dist'), { NOTYOURS_DEMO_DIR: '/x/demo' })).toBe('/x/demo');
  });
});
