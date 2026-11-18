// `notyours doctor`: is this machine ready to run notyours?
import { exec, findChrome, isPortFree, kaneBalance, kaneVersion, kaneWhoami, type Exec } from './system.js';

export const MIN_NODE_MAJOR = 22;
export const DEMO_PORT = 3077;
export const KANE_INSTALL_HINT = 'install kane-cli: https://www.testmuai.com/kane-cli/ (macOS: brew install lambdatest/kane/kane-cli)';

/** kane-cli versions notyours was tested end to end with (docs/E2E.md, docs/KANE_COMPAT.md). */
export const KANE_TESTED_MIN = '0.10.0';
export const KANE_TESTED_MAX = '0.10.6';

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** From 0.10.4, kane-cli self-heals on every web replay: replays cost credits and runs are ~3x slower. */
export const kaneReplaysCost = (v: string | undefined): boolean => !!v && compareVersions(v, '0.10.4') >= 0;

export function checkKaneVersion(v: string | undefined): Check {
  if (!v) return { name: 'kane-cli version', status: 'warn', detail: 'could not read `kane-cli --version`' };
  if (compareVersions(v, KANE_TESTED_MIN) < 0 || compareVersions(v, KANE_TESTED_MAX) > 0) {
    return {
      name: 'kane-cli version',
      status: 'warn',
      detail: `${v} is outside the tested range ${KANE_TESTED_MIN}–${KANE_TESTED_MAX}; it may work, but see docs/KANE_COMPAT.md (pin: npm i -g @testmuai/kane-cli@${KANE_TESTED_MAX})`,
    };
  }
  return {
    name: 'kane-cli version',
    status: 'ok',
    detail: kaneReplaysCost(v)
      ? `${v} (tested ${KANE_TESTED_MIN}–${KANE_TESTED_MAX}); on this version replays cost a few credits and runs are ~3× slower than 0.10.0 (docs/KANE_COMPAT.md)`
      : `${v} (tested ${KANE_TESTED_MIN}–${KANE_TESTED_MAX})`,
  };
}

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
    checks.push(checkKaneVersion(await kaneVersion(d.exec)));
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
