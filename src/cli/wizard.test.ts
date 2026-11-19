import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import type { Identity } from '../types.js';
import { detectProject } from './detect.js';
import { runWizard, type WizardDeps, type WizardOptions } from './wizard.js';
import { nyPaths, UserError } from './workspace.js';
import { readPersonas } from './personas.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ny-wizard-'));

/** An Express app like natural-app: `npm start`, PORT || 4000 in code. */
function expressApp(root: string, files: Record<string, string> = {}, scripts: Record<string, string> = { start: 'node server.js' }) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts, dependencies: { express: '^4.21.2' } }));
  fs.writeFileSync(path.join(root, 'server.js'), "const PORT = process.env.PORT || 4000;\napp.post('/signup', (req, res) => { password });\n");
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  return root;
}

function fakeDeps(over: Partial<WizardDeps> = {}) {
  const signed: string[] = [];
  const stop = vi.fn(async () => undefined);
  const deps: WizardDeps = {
    interactive: false,
    ask: vi.fn(async (_q: string, def: string) => def),
    yesNo: vi.fn(async (_q: string, def: boolean) => def),
    detect: detectProject,
    isUp: vi.fn(async () => true),
    startApp: vi.fn(async () => ({ started: true, stop })),
    balance: vi.fn(async () => 500),
    signup: vi.fn(async (id: Identity) => {
      signed.push(id.id);
      return 16;
    }),
    installHooks: vi.fn(() => ['.claude/settings.json']),
    ...over,
  };
  return { deps, signed, stop };
}

const opts = (root: string, over: Partial<WizardOptions> = {}): WizardOptions => ({ root, yes: true, hooks: true, allowHost: [], iOwnThis: false, ...over });

describe('notyours init wizard', () => {
  it('--yes: detects the start command and port, signs alice and bob up (guest has no account), writes config, secrets and personas', async () => {
    const root = expressApp(tmp());
    const { deps, signed } = fakeDeps();
    const r = await runWizard(opts(root), deps);

    expect(signed).toEqual(['alice', 'bob']);
    expect(r.creditsUsed).toBe(32);
    expect(r.personas.map((p) => [p.id, p.login])).toEqual([
      ['alice', 'signed-up'],
      ['bob', 'signed-up'],
      ['guest', 'none'],
    ]);
    const cfg = YAML.parse(fs.readFileSync(nyPaths(root).config, 'utf8'));
    expect(cfg.baseUrl).toBe('http://localhost:4000');
    expect(cfg.app).toEqual({ start: 'npm start', port: 4000 });
    const secrets = JSON.parse(fs.readFileSync(nyPaths(root).secrets, 'utf8')).identities as Identity[];
    expect(secrets.find((i) => i.id === 'alice')!.email).toMatch(/@notyours\.test$/);
    expect(secrets.find((i) => i.id === 'guest')!.password).toBeUndefined();
    expect(readPersonas(root).missingLogin).toEqual([]);
    expect(deps.installHooks).toHaveBeenCalledWith(root);
    expect(r.hooks).toBe(true);
    expect(fs.readFileSync(path.join(nyPaths(root).dir, 'personas.json'), 'utf8')).toContain('"alice"');
  });

  it('a second run keeps the same personas and does not sign them up again', async () => {
    const root = expressApp(tmp());
    await runWizard(opts(root, { hooks: false }), fakeDeps().deps);
    const before = JSON.parse(fs.readFileSync(nyPaths(root).secrets, 'utf8')).identities as Identity[];

    const second = fakeDeps();
    const r = await runWizard(opts(root, { hooks: false }), second.deps);
    expect(second.signed).toEqual([]);
    expect(r.personas.map((p) => p.login)).toEqual(['already-signed-up', 'already-signed-up', 'none']);
    const after = JSON.parse(fs.readFileSync(nyPaths(root).secrets, 'utf8')).identities as Identity[];
    expect(after.find((i) => i.id === 'alice')!.token).toBe(before.find((i) => i.id === 'alice')!.token);
    expect(after.find((i) => i.id === 'alice')!.password).toBe(before.find((i) => i.id === 'alice')!.password);
  });

  it('refuses a CAPTCHA app before writing anything, with what to do instead', async () => {
    const root = expressApp(tmp(), { 'views/signup.js': "const widget = 'https://www.google.com/recaptcha/api.js';" });
    const { deps, signed } = fakeDeps();
    const err = await runWizard(opts(root), deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as UserError).message).toMatch(/CAPTCHA/);
    expect((err as UserError).fix).toMatch(/notyours init --users users\.yaml/);
    expect(signed).toEqual([]);
    expect(fs.existsSync(nyPaths(root).config)).toBe(false);
  });

  it('refuses an OAuth-only app (no password anywhere) but not one that also has a password form', async () => {
    const oauthOnly = expressApp(tmp(), { 'auth.js': "passport.use(new GoogleStrategy({}));" });
    fs.writeFileSync(path.join(oauthOnly, 'server.js'), 'const PORT = 4000;\n'); // no password form anywhere
    await expect(runWizard(opts(oauthOnly), fakeDeps().deps)).rejects.toThrow(/OAuth/);

    const both = expressApp(tmp(), { 'auth.js': "passport.use(new GoogleStrategy({})); const password = 1;" });
    await expect(runWizard(opts(both), fakeDeps().deps)).resolves.toBeDefined();
  });

  it('starts the app when nothing answers, and stops it when the wizard ends', async () => {
    const root = expressApp(tmp());
    const isUp = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { deps, stop } = fakeDeps({ isUp });
    const r = await runWizard(opts(root), deps);
    expect(deps.startApp).toHaveBeenCalledWith('npm start', root, 4000, 'http://localhost:4000');
    expect(r.app.started).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('nothing answers and there is no start command: says what to do, signs nobody up', async () => {
    const root = expressApp(tmp(), {}, {});
    const { deps, signed } = fakeDeps({ isUp: vi.fn(async () => false) });
    const err = (await runWizard(opts(root), deps).catch((e: unknown) => e)) as UserError;
    expect(err.message).toMatch(/Nothing answers at http:\/\/localhost:4000/);
    expect(err.fix).toMatch(/--start/);
    expect(signed).toEqual([]);
  });

  it('an agent-run wizard never starts an unapproved start command (startApp is not called)', async () => {
    const root = expressApp(tmp());
    const { deps } = fakeDeps({ isUp: vi.fn(async () => false) });
    const err = (await runWizard(opts(root, { mayStartApp: () => false }), deps).catch((e: unknown) => e)) as UserError;
    expect(err.message).toMatch(/not been approved on this machine/);
    expect(deps.startApp).not.toHaveBeenCalled();
  });

  it('a failed sign-up stops the run; the personas that did sign up are remembered', async () => {
    const root = expressApp(tmp());
    let calls = 0;
    const { deps } = fakeDeps({
      signup: vi.fn(async (id: Identity) => {
        calls++;
        if (id.id === 'bob') throw new UserError('Sign-up for bob failed.', 'check the sign-up page');
        return 16;
      }),
    });
    await expect(runWizard(opts(root), deps)).rejects.toThrow(/Sign-up for bob failed/);
    expect(calls).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(nyPaths(root).dir, 'personas.json'), 'utf8')).signedUp).toEqual(['alice']);
  });

  it('checks the Kane balance before the first sign-up', async () => {
    const root = expressApp(tmp());
    const { deps, signed } = fakeDeps({ balance: vi.fn(async () => 10) });
    await expect(runWizard(opts(root), deps)).rejects.toThrow(/below creditFloor/);
    expect(signed).toEqual([]);
  });

  it('--users: takes existing accounts, signs nobody up, and needs no running app', async () => {
    const root = expressApp(tmp());
    const usersFile = path.join(root, 'users.yaml');
    fs.writeFileSync(usersFile, 'users:\n  - { id: alice, role: owner, plan: pro, email: a@example.test, password: hunter2-long }\n  - { id: bob, role: viewer, email: b@example.test, password: hunter3-long }\n');
    const { deps, signed } = fakeDeps({ isUp: vi.fn(async () => false) });
    const r = await runWizard(opts(root, { users: usersFile }), deps);
    expect(signed).toEqual([]);
    expect(deps.isUp).not.toHaveBeenCalled();
    expect(r.personas.map((p) => p.login)).toEqual(['users-file', 'users-file']);
    const secrets = JSON.parse(fs.readFileSync(nyPaths(root).secrets, 'utf8')).identities as Identity[];
    expect(secrets.find((i) => i.id === 'alice')!.password).toBe('hunter2-long');
  });

  it('a non-local URL needs --allow-host and --i-own-this', async () => {
    const root = expressApp(tmp());
    await expect(runWizard(opts(root, { url: 'https://staging.example.com' }), fakeDeps().deps)).rejects.toThrow(/Refusing to init/);
    expect(fs.existsSync(nyPaths(root).config)).toBe(false);
  });

  it('interactive: asks for the start command, port and URL and takes the answers; a "no" skips the hooks', async () => {
    const root = expressApp(tmp());
    const answers: Record<string, string> = { 'App start command': 'node server.js', 'App port': '4100', 'Base URL': 'http://localhost:4100' };
    const ask = vi.fn(async (q: string, def: string) => Object.entries(answers).find(([k]) => q.startsWith(k))?.[1] ?? def);
    const { deps } = fakeDeps({ interactive: true, ask, yesNo: vi.fn(async () => false) });
    const r = await runWizard(opts(root, { yes: false }), deps);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(r.baseUrl).toBe('http://localhost:4100');
    expect(deps.installHooks).not.toHaveBeenCalled();
    expect(YAML.parse(fs.readFileSync(nyPaths(root).config, 'utf8')).app).toEqual({ start: 'node server.js', port: 4100 });
  });

  it('without a terminal and without --yes: the defaults, and no hooks are installed without a person', async () => {
    const root = expressApp(tmp());
    const { deps } = fakeDeps({ interactive: false });
    const r = await runWizard(opts(root, { yes: false }), deps);
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.installHooks).not.toHaveBeenCalled();
    expect(r.hooks).toBe(false);
  });
});
