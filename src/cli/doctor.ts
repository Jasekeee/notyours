// `notyours doctor`: is this machine ready to run notyours?
import { exec, findChrome, isPortFree, kaneBalance, kaneWhoami, type Exec } from './system.js';

export const MIN_NODE_MAJOR = 22;
export const DEMO_PORT = 3077;
export const KANE_INSTALL_HINT = 'install kane-cli: https://www.testmuai.com/kane-cli/ (macOS: brew install lambdatest/kane/kane-cli)';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export function nodeUpgradeHint(version: string): string {
  return `Node ${version} found; notyours requires Node ${MIN_NODE_MAJOR}+. Upgrade: \`nvm install ${MIN_NODE_MAJOR}\` (or \`fnm install ${MIN_NODE_MAJOR}\`, or https://nodejs.org)`;
}

export function checkNode(version = process.versions.node): Check {
  const major = Number(version.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: 'Node', status: 'ok', detail: `v${version}` }
    : { name: 'Node', status: 'fail', detail: nodeUpgradeHint(version) };
}

export interface DoctorDeps {
  exec: Exec;
  findChrome: () => string | undefined;
  isPortFree: (port: number) => Promise<boolean>;
  nodeVersion: string;
}

const defaultDeps: DoctorDeps = { exec, findChrome: () => findChrome(), isPortFree, nodeVersion: process.versions.node };

export async function runDoctor(creditFloor: number, deps: Partial<DoctorDeps> = {}): Promise<Check[]> {
  const d = { ...defaultDeps, ...deps };
  const checks: Check[] = [checkNode(d.nodeVersion)];

  const chrome = d.findChrome();
  checks.push(
    chrome
      ? { name: 'Chrome', status: 'ok', detail: chrome }
      : { name: 'Chrome', status: 'fail', detail: 'Google Chrome not found. Install it, or set CHROME_PATH=/path/to/chrome' },
  );

  const auth = await kaneWhoami(d.exec);
  if (auth.state === 'missing') {
    checks.push({ name: 'kane-cli', status: 'fail', detail: `kane-cli not found: ${KANE_INSTALL_HINT}` });
  } else {
    checks.push(
      auth.state === 'ok'
        ? { name: 'kane-cli login', status: 'ok', detail: 'authenticated' }
        : { name: 'kane-cli login', status: 'fail', detail: 'not authenticated: run `kane-cli login`' },
    );
    const balance = auth.state === 'ok' ? await kaneBalance(d.exec) : undefined;
    if (balance === undefined) {
      checks.push({ name: 'Kane credits', status: 'warn', detail: 'could not read `kane-cli balance`' });
    } else if (balance < creditFloor) {
      checks.push({
        name: 'Kane credits',
        status: 'warn',
        detail: `${balance.toFixed(0)} left, below creditFloor ${creditFloor}: authoring runs (~30 credits each) are refused; replays (0 credits) still work`,
      });
    } else {
      checks.push({ name: 'Kane credits', status: 'ok', detail: `${balance.toFixed(0)} available (floor ${creditFloor})` });
    }
  }

  checks.push(
    (await d.isPortFree(DEMO_PORT))
      ? { name: `Port ${DEMO_PORT}`, status: 'ok', detail: 'free' }
      : { name: `Port ${DEMO_PORT}`, status: 'fail', detail: `in use (the demo app needs it). Find it: lsof -i :${DEMO_PORT}` },
  );
  return checks;
}
