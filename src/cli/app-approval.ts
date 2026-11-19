// A person approves the app's start command once, on this machine. config.yaml is committed and can come from a
// clone or an agent's shell, so `app.start` is only run when the fingerprint of (start, port) matches the approval
// the person recorded in .notyours/app-approved.json (gitignored, read-only to the coding agent).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appPort, type AppSettings } from '../hooks/app-freshness.js';
import { safeMkdir, safeWriteFile } from './safe-fs.js';
import { nyPaths } from './workspace.js';

export const APPROVAL_FILE = 'app-approved.json';

export function startFingerprint(start: string, port: number): string {
  return createHash('sha256').update(JSON.stringify({ start, port })).digest('hex');
}

/** Records that the person approved running `start` on `port` for this project. */
export function approveStart(root: string, start: string, port: number): void {
  safeMkdir(root, nyPaths(root).dir);
  safeWriteFile(root, path.join(nyPaths(root).dir, APPROVAL_FILE), `${JSON.stringify({ fingerprint: startFingerprint(start, port), approvedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

/** True only when the app.start in config.yaml is the one the person approved here. */
export function isStartApproved(root: string, app: AppSettings, baseUrl: string): boolean {
  if (!app.start) return false;
  const file = path.join(nyPaths(root).dir, APPROVAL_FILE);
  try {
    const approved = (JSON.parse(fs.readFileSync(file, 'utf8')) as { fingerprint?: string }).fingerprint;
    return approved === startFingerprint(app.start, appPort(app, baseUrl));
  } catch {
    return false;
  }
}
