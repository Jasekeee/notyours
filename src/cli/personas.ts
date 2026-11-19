// Persona bookkeeping for the wizard and status. Ids and sign-up state only: passwords stay in secrets.json.
import fs from 'node:fs';
import path from 'node:path';
import { nyPaths, readIdentities } from './workspace.js';
import { safeMkdir } from './safe-fs.js';

/** Per-project file of persona ids already signed up (no secrets; gitignored). */
export const PERSONAS_FILE = 'personas.json';

/** Personas already signed up by an earlier wizard run. */
export function readSignedUp(root: string): Set<string> {
  try {
    const file = path.join(nyPaths(root).dir, PERSONAS_FILE);
    return new Set((JSON.parse(fs.readFileSync(file, 'utf8')) as { signedUp?: string[] }).signedUp ?? []);
  } catch {
    return new Set();
  }
}

export function writeSignedUp(root: string, ids: Set<string>): void {
  safeMkdir(root, nyPaths(root).dir);
  fs.writeFileSync(path.join(nyPaths(root).dir, PERSONAS_FILE), `${JSON.stringify({ signedUp: [...ids].sort() }, null, 2)}\n`);
}

/** Who the project has: all persona ids, and which of them can log in (guests never have a login). */
export function readPersonas(root: string): { all: string[]; withLogin: string[]; missingLogin: string[] } {
  if (!fs.existsSync(nyPaths(root).secrets)) return { all: [], withLogin: [], missingLogin: [] };
  const ids = readIdentities(root);
  const withLogin = ids.filter((i) => i.role === 'guest' || (i.email && i.password)).map((i) => i.id);
  const missingLogin = ids.filter((i) => i.role !== 'guest' && !(i.email && i.password)).map((i) => i.id);
  return { all: ids.map((i) => i.id), withLogin, missingLogin };
}
