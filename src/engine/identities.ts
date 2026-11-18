// Test identities: tokens, ports, profiles. Passwords live only in .notyours/secrets.json (0600).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { IdentityIdSchema, IdentitySchema, PlanSchema, RoleSchema } from '../schemas.js';
import { makeToken } from '../shared/token.js';
import type { Identity, Plan, Role } from '../types.js';

export interface IdentitySpec {
  id: string;
  role: Role;
  plan: Plan;
  email?: string;
  password?: string;
}

/** Alice, Bob, a guest and a free user. */
export const DEFAULT_SPECS: IdentitySpec[] = [
  { id: 'alice', role: 'owner', plan: null },
  { id: 'bob', role: 'viewer', plan: null },
  { id: 'guest', role: 'guest', plan: null },
  { id: 'free_user', role: 'free', plan: 'free' },
];

const rand = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 16);

/** Random password that passes common policies (upper, lower, digit, symbol, 20 chars). */
export function generatePassword(): string {
  return `Ny${rand()}7!`;
}

export function defaultBasePort(): number {
  return Number(process.env.NOTYOURS_CDP_BASE_PORT ?? 9301);
}

export interface CreateOptions {
  stateDir: string;
  basePort?: number;
  /** Domain for generated sign-up emails. Default example.com (reserved, never delivers). */
  emailDomain?: string;
}

/** Build identities from specs: fresh token, CDP port, profile dir; email/password generated for non-guests. */
export function createIdentities(specs: IdentitySpec[], opts: CreateOptions): Identity[] {
  const base = opts.basePort ?? defaultBasePort();
  const ids = new Set<string>();
  return specs.map((s, i) => {
    if (ids.has(s.id)) throw new Error(`Duplicate identity id: ${s.id}`);
    ids.add(s.id);
    const guest = s.role === 'guest';
    return IdentitySchema.parse({
      id: s.id,
      role: s.role,
      plan: s.plan,
      ...(guest ? {} : {
        email: s.email ?? `notyours+${s.id.replace(/_/g, '-')}-${rand().slice(0, 6)}@${opts.emailDomain ?? 'example.com'}`,
        password: s.password ?? generatePassword(),
      }),
      token: makeToken(s.id),
      cdpPort: base + i,
      userDataDir: resolve(opts.stateDir, 'profiles', s.id),
    });
  });
}

const paths = (stateDir: string) => ({
  identities: join(stateDir, 'identities.json'),
  secrets: join(stateDir, 'secrets.json'),
});

/** identities.json gets everything except passwords; secrets.json (0600) gets only passwords. */
export function saveIdentities(stateDir: string, identities: Identity[]): void {
  mkdirSync(stateDir, { recursive: true });
  const p = paths(stateDir);
  const publicIds = identities.map(({ password: _pw, ...rest }) => rest);
  writeFileSync(p.identities, `${JSON.stringify(publicIds, null, 2)}\n`);
  const secrets: Record<string, { password: string }> = {};
  for (const i of identities) if (i.password) secrets[i.id] = { password: i.password };
  writeFileSync(p.secrets, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  chmodSync(p.secrets, 0o600); // mode only applies on create
}

export function loadIdentities(stateDir: string): Identity[] {
  const p = paths(stateDir);
  if (!existsSync(p.identities)) {
    throw new Error(`No identities at ${p.identities}. Create them first (sign-up or --users).`);
  }
  const publicIds = JSON.parse(readFileSync(p.identities, 'utf8')) as Record<string, unknown>[];
  const secrets = existsSync(p.secrets)
    ? (JSON.parse(readFileSync(p.secrets, 'utf8')) as Record<string, { password?: string }>)
    : {};
  return publicIds.map((raw) => {
    const id = String(raw.id);
    const pw = secrets[id]?.password;
    return IdentitySchema.parse(pw ? { ...raw, password: pw } : raw);
  });
}

const UserSchema = z.object({
  id: IdentityIdSchema.optional(),
  email: z.string().min(3),
  password: z.string().min(1),
  role: RoleSchema.optional(),
  plan: PlanSchema.optional(),
});
const UsersFileSchema = z.array(UserSchema).min(1);

function slugFromEmail(email: string): string {
  const s = email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 32);
  return s || 'user';
}

/**
 * Import existing accounts from a users.json: [{email, password, id?, role?, plan?}, ...].
 * Roles default by order (owner, viewer, viewer...). A guest is appended if none is listed.
 */
export function importUsers(file: string, opts: CreateOptions): Identity[] {
  const parsed = UsersFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid users file ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const specs: IdentitySpec[] = parsed.data.map((u, i) => ({
    id: u.id ?? slugFromEmail(u.email),
    role: u.role ?? (i === 0 ? 'owner' : 'viewer'),
    plan: u.plan ?? null,
    email: u.email,
    password: u.password,
  }));
  if (!specs.some((s) => s.role === 'guest')) specs.push({ id: 'guest', role: 'guest', plan: null });
  return createIdentities(specs, opts);
}

export function byId(identities: Identity[], id: string): Identity {
  const found = identities.find((i) => i.id === id);
  if (!found) throw new Error(`Unknown identity "${id}". Known: ${identities.map((i) => i.id).join(', ')}`);
  return found;
}
