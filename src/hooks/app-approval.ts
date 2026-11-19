// A person approves the app's start command once, on this machine. config.yaml is committed and can come from a
// clone or an agent's shell, so `app.start` is only run when the fingerprint of (start, port) matches the approval
// the person recorded in <project>/.notyours/app-approved.json (gitignored, read-only to the coding agent).
// Both the CLI (`init`, `withApp`) and the Stop hook's app restart use this one check.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const APPROVAL_FILE = 'app-approved.json';

export function startFingerprint(start: string, port: number): string {
  return createHash('sha256').update(JSON.stringify({ start, port })).digest('hex');
}

/** True only when exactly this start command and port were approved in `ny` (the project's .notyours/ folder). */
export function isApprovedIn(ny: string, start: string, port: number): boolean {
  try {
    const approved = (JSON.parse(fs.readFileSync(path.join(ny, APPROVAL_FILE), 'utf8')) as { fingerprint?: string }).fingerprint;
    return approved === startFingerprint(start, port);
  } catch {
    return false;
  }
}
