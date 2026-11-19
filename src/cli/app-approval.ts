// The CLI side of the app.start approval: `init` (a person, in a terminal) records it; `withApp` and the agent-run
// wizard check it. The check itself lives in hooks/app-approval.ts, which the Stop hook also uses.
import path from 'node:path';
import { appPort, type AppSettings } from '../hooks/app-freshness.js';
import { APPROVAL_FILE, isApprovedIn, startFingerprint } from '../hooks/app-approval.js';
import { safeMkdir, safeWriteFile } from './safe-fs.js';
import { nyPaths } from './workspace.js';

export { APPROVAL_FILE, startFingerprint };

/** Records that the person approved running `start` on `port` for this project. */
export function approveStart(root: string, start: string, port: number): void {
  safeMkdir(root, nyPaths(root).dir);
  safeWriteFile(root, path.join(nyPaths(root).dir, APPROVAL_FILE), `${JSON.stringify({ fingerprint: startFingerprint(start, port), approvedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

/** True only when exactly this start command and port were approved here. */
export function isApprovedFor(root: string, start: string, port: number): boolean {
  return isApprovedIn(nyPaths(root).dir, start, port);
}

/** True only when the app.start in config.yaml is the one the person approved here. */
export function isStartApproved(root: string, app: AppSettings, baseUrl: string): boolean {
  return !!app.start && isApprovedFor(root, app.start, appPort(app, baseUrl));
}
