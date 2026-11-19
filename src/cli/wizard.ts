// `notyours init`: the wizard. Detects the app, proposes app.start / app.port / baseUrl, creates the personas and
// signs them up through Kane (or takes existing accounts with --users), writes the boundary drafts, and offers the
// Claude Code hooks. Every Kane step prints its credit estimate first. Dependencies are injected so tests run
// without Chrome, Kane or a network.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildIdentities, parseUsersFile, readPublicIdentities, type UserEntry } from './init.js';
import { LOCAL_HOSTS, checkHost, isLocalHost } from './hosts.js';
import { blockerMessage, startCommandFor, type Detection } from './detect.js';
import type { AppHandle } from './app-process.js';
import { recordOwnedHosts } from './owned.js';
import { safeMkdir } from './safe-fs.js';
import { UserError, nyPaths, readConfigIfExists, readIdentities, writeAppSettings, writeConfig, writeIdentities } from './workspace.js';
import { step, say, table, kv } from './output.js';
import { readSignedUp, writeSignedUp } from './personas.js';
import pc from 'picocolors';
import { ConfigSchema } from '../schemas.js';
import type { Config, Identity, Role } from '../types.js';
import { generatePassword } from '../engine/identities.js';
import { UnsupportedSignupError } from '../engine/signup.js';
import { scanProject } from '../map/scan.js';
import { runMap, type MapResult } from '../map/index.js';

export const SIGNUP_CREDITS_ESTIMATE = 16;

/** The personas a default run signs up. The guest has no account. free_user joins only when the app has a plan gate. */
export const WIZARD_PERSONAS: Array<{ id: string; role: Role; plan: 'free' | 'pro' | null }> = [
  { id: 'alice', role: 'owner', plan: null },
  { id: 'bob', role: 'viewer', plan: null },
  { id: 'guest', role: 'guest', plan: null },
];
export const PLAN_PERSONA = { id: 'free_user', role: 'free' as Role, plan: 'free' as const };

export interface WizardOptions {
  /** Project folder. */
  root: string;
  url?: string;
  start?: string;
  port?: number;
  /** An existing accounts file (--users): no sign-up runs. */
  users?: string;
  /** Take the defaults without asking (agents, CI). */
  yes: boolean;
  /** Offer / install the Claude Code hooks and slash commands. */
  hooks: boolean;
  allowHost: string[];
  iOwnThis: boolean;
}

export interface WizardDeps {
  /** A person can answer questions (a TTY, and not --yes). */
  interactive: boolean;
  ask(question: string, def: string): Promise<string>;
  yesNo(question: string, def: boolean): Promise<boolean>;
  detect(root: string): Detection;
  isUp(url: string): Promise<boolean>;
  startApp(cmd: string, cwd: string, port: number, url: string): Promise<AppHandle>;
  /** Credit balance, or undefined when it can't be read. */
  balance(): Promise<number | undefined>;
  /** Sign one persona up in its own Chrome. Returns the credits the run used. Throws UserError on failure. */
  signup(identity: Identity, cfg: Config): Promise<number>;
  /** Install the hooks and slash commands; returns the files written. */
  installHooks(root: string): string[];
}

export interface WizardResult {
  baseUrl: string;
  app: { start?: string; port: number; started: boolean };
  detection: Pick<Detection, 'framework' | 'startScript' | 'port' | 'portSource' | 'filesScanned'>;
  personas: Array<{ id: string; role: Role; login: 'signed-up' | 'already-signed-up' | 'users-file' | 'none' }>;
  creditsUsed: number;
  routes: number;
  drafts: Array<{ id: string; file: string; skipped: boolean }>;
  hooks: boolean;
  /** Files the hook install wrote (empty when hooks were skipped). */
  hookFiles: string[];
  elapsedMs: number;
}

const randomEmail = (id: string) => `notyours+${id.replace(/_/g, '-')}-${randomBytes(3).toString('hex')}@notyours.test`;

function portOf(url: string): number {
  const u = new URL(url);
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
}

export async function runWizard(opts: WizardOptions, deps: WizardDeps): Promise<WizardResult> {
  const t0 = Date.now();
  const root = opts.root;
  const detection = deps.detect(root);
  // A CAPTCHA, OAuth-only or SMS app can't be signed up by Kane: refuse before anything is written.
  if (detection.blockers.length && !opts.users) {
    const b = blockerMessage(detection.blockers);
    throw new UserError(b.message, b.fix);
  }

  say('Detected');
  say(
    kv([
      ['framework', detection.framework],
      ['start', startCommandFor(detection) ?? '(no start or dev script)'],
      ['port', `${detection.port} (${detection.portSource})`],
      ['files read', String(detection.filesScanned)],
    ]),
  );
  say();

  // Settings: flags win, then the detected defaults. Without --yes and with a terminal, a person can change each one.
  const asks = !opts.yes && deps.interactive;
  const suggestedStart = startCommandFor(detection);
  const startAnswer = opts.start ?? (asks ? await deps.ask('App start command (blank for none)', suggestedStart ?? '') : (suggestedStart ?? ''));
  const start = startAnswer.trim() || undefined;
  const port = opts.port ?? (asks ? Number(await deps.ask('App port', String(detection.port))) : detection.port);
  const url = opts.url ?? (asks ? await deps.ask('Base URL', `http://localhost:${port}`) : `http://localhost:${port}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError(`Port must be a whole number from 1 to 65535 (got ${port}).`, 'rerun with --port <n>.');

  // The host gate: a non-local URL needs --allow-host and --i-own-this (the terminal confirmation is in the CLI).
  const prev = readConfigIfExists(root);
  const allowHosts = [...new Set([...(prev?.allowHosts ?? LOCAL_HOSTS), ...opts.allowHost.map((h) => h.toLowerCase())])];
  let check: ReturnType<typeof checkHost>;
  try {
    check = checkHost(url, allowHosts, opts.iOwnThis);
  } catch (e) {
    throw new UserError((e as Error).message, 'use an http(s) URL, e.g. http://localhost:3000.');
  }
  if (!check.ok) throw new UserError(`Refusing to init: ${check.reason}`, 'use localhost, or pass --allow-host <host> --i-own-this if you own that host.');

  // Personas: existing ones keep their tokens, ports and passwords (so recorded tests stay valid). Generated ones are new.
  const signedUp = readSignedUp(root);
  const existing = existingSecrets(root);
  const isPlanGated = scanProject(root).some((r) => r.planGate);
  let identities: Identity[];
  const personas: WizardResult['personas'] = [];
  const toSignUp: Identity[] = [];
  if (opts.users) {
    // Existing accounts: no sign-up. Passwords come from the file (or its passwordEnv), never from the terminal.
    identities = buildIdentities(root, parseUsersFile(opts.users), existing);
    for (const i of identities) personas.push({ id: i.id, role: i.role, login: i.role === 'guest' ? 'none' : 'users-file' });
  } else {
    const specs = [...WIZARD_PERSONAS, ...(isPlanGated ? [PLAN_PERSONA] : [])];
    const users: UserEntry[] = specs.map((s) => {
      const base: UserEntry = { id: s.id, role: s.role, plan: s.plan };
      if (s.role === 'guest') return base;
      const prevId = existing.find((e) => e.id === s.id);
      return { ...base, email: prevId?.email ?? randomEmail(s.id), password: prevId?.password ?? generatePassword() };
    });
    identities = buildIdentities(root, users, existing);
    for (const i of identities) {
      if (i.role === 'guest') personas.push({ id: i.id, role: i.role, login: 'none' });
      // "Signed up" only counts when we still hold its password: otherwise the account can't be logged into.
      else if (signedUp.has(i.id) && i.password) personas.push({ id: i.id, role: i.role, login: 'already-signed-up' });
      else toSignUp.push(i);
    }
  }

  // Write the project first: config (with app.start / app.port), identities with their passwords.
  const cfg = ConfigSchema.parse({ ...(prev ?? {}), baseUrl: url, allowHosts });
  writeConfig(root, cfg);
  if (start) writeAppSettings(root, { start, port });
  if (!isLocalHost(check.host) && opts.iOwnThis) recordOwnedHosts(root, [check.host, ...opts.allowHost]);
  writeIdentities(root, identities);
  safeMkdir(root, nyPaths(root).boundaries);

  let app: AppHandle = { started: false, stop: async () => undefined };
  try {
    let creditsUsed = 0;
    if (toSignUp.length) {
      // Sign-ups need the app answering. Start it with app.start if it isn't.
      if (!(await deps.isUp(url))) {
        if (!start) throw new UserError(`Nothing answers at ${url}, and there is no start command.`, 'start your app, or pass --start "<command>" so notyours can start it.');
        const s = step(`start the app (${start})`);
        try {
          app = await deps.startApp(start, root, port, url);
          s.done(`answering at ${url}`);
        } catch (e) {
          s.fail((e as Error).message);
          throw new UserError(`The app did not start: ${(e as Error).message}`, `run \`${start}\` yourself, check the error, then rerun notyours init.`);
        }
      } else {
        say(`${pc.green('✓')} app already answering at ${url}`);
      }
      const bal = await deps.balance();
      if (bal === undefined) throw new UserError('Could not read your Kane balance (`kane-cli balance`).', 'run `kane-cli login`, then `notyours doctor`.');
      if (bal < cfg.creditFloor) {
        throw new UserError(`Kane balance ${bal.toFixed(0)} is below creditFloor ${cfg.creditFloor}: not signing personas up.`, 'top up Kane, or lower creditFloor in .notyours/config.yaml.');
      }
      say(pc.dim(`Kane balance ${bal.toFixed(0)}; signing up ${toSignUp.length} persona${toSignUp.length === 1 ? '' : 's'} (~${SIGNUP_CREDITS_ESTIMATE * toSignUp.length} credits).`));
      for (const identity of toSignUp) {
        const s = step(`sign up ${identity.id} (${identity.role})`, SIGNUP_CREDITS_ESTIMATE);
        try {
          const credits = await deps.signup(identity, cfg);
          creditsUsed += credits;
          signedUp.add(identity.id);
          writeSignedUp(root, signedUp);
          personas.push({ id: identity.id, role: identity.role, login: 'signed-up' });
          s.done(undefined, credits);
        } catch (e) {
          s.fail((e as Error).message.split('\n')[0]);
          if (e instanceof UnsupportedSignupError) throw new UserError(e.message, 'create the accounts yourself and run `notyours init --users users.yaml`.');
          throw e;
        }
      }
    }
    personas.sort((a, b) => order(a.id) - order(b.id));

    // Boundary drafts from the static scan (no AI, no credits). A person or Claude finishes them.
    const map: MapResult = runMap({ root, baseUrl: url, identities });
    const drafts = map.drafts.map((d) => ({ id: d.boundary.id, file: path.relative(root, d.file), skipped: d.skipped }));

    // Hooks change .claude/: with --yes they are installed; with a terminal they are asked; otherwise they are not.
    let hookFiles: string[] = [];
    if (opts.hooks) {
      const install = opts.yes ? true : deps.interactive ? await deps.yesNo('Install the Claude Code hooks and the /notyours-map and /notyours-check commands? (recommended)', true) : false;
      if (install) hookFiles = deps.installHooks(root);
    }

    const result: WizardResult = {
      baseUrl: url,
      app: { ...(start ? { start } : {}), port, started: app.started },
      detection: { framework: detection.framework, ...(detection.startScript ? { startScript: detection.startScript } : {}), port: detection.port, portSource: detection.portSource, filesScanned: detection.filesScanned },
      personas,
      creditsUsed,
      routes: map.routes.length,
      drafts,
      hooks: hookFiles.length > 0,
      hookFiles,
      elapsedMs: Date.now() - t0,
    };
    return result;
  } finally {
    await app.stop();
  }
}

const ORDER = ['alice', 'bob', 'guest', 'free_user'];
const order = (id: string) => {
  const i = ORDER.indexOf(id);
  return i < 0 ? ORDER.length : i;
};

/** Identities from an earlier init: secrets.json (with passwords), else the committed identities.json (tokens only). */
function existingSecrets(root: string): Identity[] {
  return fs.existsSync(nyPaths(root).secrets) ? readIdentities(root) : readPublicIdentities(root);
}

/** Human summary after the wizard: a table of personas and the single next step. Plain text, no secrets. */
export function summaryLines(r: WizardResult): string[] {
  const rows = r.personas.map((p) => [p.id, p.role, p.login]);
  const lines = [
    '',
    'Personas',
    table(['id', 'role', 'login'], rows),
    '',
    `app ${r.app.start ?? '(not started by notyours)'}  port ${r.app.port}  baseUrl ${r.baseUrl}`,
    `routes ${r.routes}, boundary drafts ${r.drafts.length}${r.drafts.length ? ` (${r.drafts.map((d) => d.id).join(', ')})` : ''}`,
    `Kane credits used ${r.creditsUsed.toFixed(1)}; time ${Math.round(r.elapsedMs / 1000)} s`,
  ];
  if (r.drafts.length) {
    lines.push('', 'Next: in Claude Code run /notyours-map (turns the drafts into boundaries), then `notyours run`.');
  } else {
    lines.push('', 'Next: write a boundary in .notyours/boundaries/ (see README), then `notyours run --dry-run`.');
  }
  return lines;
}
