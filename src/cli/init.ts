// `notyours init`: write .notyours/config.yaml and .notyours/secrets.json (identities with fresh canary tokens).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { IdentityIdSchema, PlanSchema, RoleSchema } from '../schemas.js';
import { makeToken } from '../shared/token.js';
import type { Identity } from '../types.js';
import { LOCAL_HOSTS, checkHost, isLocalHost } from './hosts.js';
import { recordOwnedHosts } from './owned.js';
import { safeMkdir } from './safe-fs.js';
import { UserError, nyPaths, readConfigIfExists, writeConfig, writeIdentities } from './workspace.js';

/** One entry of the --users file (YAML or JSON): either a list, or { users: [...] }. */
export const UserEntrySchema = z.object({
  id: IdentityIdSchema,
  role: RoleSchema,
  plan: PlanSchema.optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  /** Read the password from this environment variable instead of the file. */
  passwordEnv: z.string().optional(),
});
export type UserEntry = z.infer<typeof UserEntrySchema>;

export const DEFAULT_USERS: UserEntry[] = [
  { id: 'alice', role: 'owner', plan: 'pro' },
  { id: 'bob', role: 'viewer', plan: 'free' },
  { id: 'guest', role: 'guest', plan: null },
  { id: 'free_user', role: 'free', plan: 'free' },
];

export const FIRST_CDP_PORT = 9301;

export function parseUsersFile(file: string): UserEntry[] {
  if (!fs.existsSync(file)) throw new UserError(`--users file not found: ${file}`);
  const raw = YAML.parse(fs.readFileSync(file, 'utf8')) as unknown; // YAML is a superset of JSON
  const list = Array.isArray(raw) ? raw : (raw as { users?: unknown } | null)?.users;
  const r = z.array(UserEntrySchema).min(1).safeParse(list);
  if (!r.success) {
    // Never echo values: the file holds passwords.
    throw new UserError(`--users file ${file} is invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const ids = r.data.map((u) => u.id);
  const dup = ids.find((id, n) => ids.indexOf(id) !== n);
  if (dup) throw new UserError(`--users file ${file}: duplicate id "${dup}"`);
  return r.data;
}

/** Turn user entries into identities. Existing tokens/ports are kept so recorded tests stay valid. */
export function buildIdentities(root: string, users: UserEntry[], existing: Identity[] = [], env = process.env): Identity[] {
  const profiles = nyPaths(root).profiles;
  const usedPorts = new Set(existing.map((e) => e.cdpPort));
  let nextPort = FIRST_CDP_PORT;
  const freePort = () => {
    while (usedPorts.has(nextPort)) nextPort++;
    usedPorts.add(nextPort);
    return nextPort;
  };
  return users.map((u) => {
    const prev = existing.find((e) => e.id === u.id);
    const password = u.passwordEnv ? env[u.passwordEnv] : u.password;
    if (u.passwordEnv && password === undefined) throw new UserError(`User ${u.id}: environment variable ${u.passwordEnv} is not set`);
    const id: Identity = {
      id: u.id,
      role: u.role,
      plan: u.plan === undefined ? (u.role === 'pro' ? 'pro' : u.role === 'guest' ? null : 'free') : u.plan,
      token: prev?.token ?? makeToken(u.id),
      cdpPort: prev?.cdpPort ?? freePort(),
      userDataDir: prev?.userDataDir ?? path.join(profiles, u.id),
    };
    if (u.email !== undefined) id.email = u.email;
    if (password !== undefined) id.password = password;
    return id;
  });
}

export interface InitOptions {
  url: string;
  users?: string;
  allowHost?: string[];
  iOwnThis?: boolean;
}

export interface InitResult {
  baseUrl: string;
  identities: Identity[];
  allowHosts: string[];
}

export function runInit(root: string, opts: InitOptions, existingIdentities: Identity[] = []): InitResult {
  const prev = readConfigIfExists(root);
  const allowHosts = [...new Set([...(prev?.allowHosts ?? LOCAL_HOSTS), ...(opts.allowHost ?? []).map((h) => h.toLowerCase())])];
  let check;
  try {
    check = checkHost(opts.url, allowHosts, opts.iOwnThis === true);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  if (!check.ok) throw new UserError(`Refusing to init: ${check.reason}`);

  const users = opts.users ? parseUsersFile(opts.users) : DEFAULT_USERS;
  const identities = buildIdentities(root, users, existingIdentities);
  writeConfig(root, { ...(prev ?? {}), baseUrl: opts.url, allowHosts });
  // The human's confirmation lives outside the repo, so a cloned config.yaml can't grant it.
  if (opts.iOwnThis) recordOwnedHosts(root, [check.host, ...(opts.allowHost ?? [])].filter((h) => !isLocalHost(h.toLowerCase())));
  writeIdentities(root, identities);
  safeMkdir(root, nyPaths(root).boundaries);
  return { baseUrl: opts.url, identities, allowHosts };
}
