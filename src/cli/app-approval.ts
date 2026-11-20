// The CLI side of the app.start approval: `init` (a person, in a terminal) records it; `withApp` and the agent-run
// wizard check it. The storage and the check live in hooks/app-approval.ts, which the Stop hook also uses.
import { appPort, type AppSettings } from '../hooks/app-freshness.js';
import { approveStart, isAppStartApproved } from '../hooks/app-approval.js';

export { approveStart };

/** True only when exactly this start command and port were approved for this project on this machine. */
export function isApprovedFor(root: string, start: string, port: number): boolean {
  return isAppStartApproved(root, start, port);
}

/** True only when the app.start in config.yaml is the one the person approved here. */
export function isStartApproved(root: string, app: AppSettings, baseUrl: string): boolean {
  return !!app.start && isApprovedFor(root, app.start, appPort(app, baseUrl));
}
