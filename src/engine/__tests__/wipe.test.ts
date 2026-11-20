import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freePortRange, killChromesUsing } from './test-ports.js';
import { ChromePool } from '../chrome.js';
import { wipeProfile } from '../probes.js';
import type { Identity } from '../../types.js';

const real = realpathSync(mkdtempSync(join(tmpdir(), 'ny-wipe-')));
const alias = `${real}-alias`;
symlinkSync(real, alias); // like macOS /tmp -> /private/tmp
afterAll(() => { killChromesUsing(real); rmSync(alias, { force: true }); rmSync(real, { recursive: true, force: true }); });

let wipePort = 0;
beforeAll(async () => { wipePort = await freePortRange(1); });
const guest = (dir: string): Identity => ({ id: 'guest', role: 'guest', plan: null, token: 'NY-GUEST-AAAAAAAAAAAA', cdpPort: wipePort, userDataDir: dir });

describe('wipeProfile', () => {
  it('accepts a profile reached through a symlinked path (Claude Code passes the real path)', async () => {
    const profile = join(real, '.notyours', 'profiles', 'guest');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'Cookies'), 'x');
    await wipeProfile(guest(join(alias, '.notyours', 'profiles', 'guest')), { stateDir: join(real, '.notyours'), pool: new ChromePool() });
    expect(existsSync(profile)).toBe(false);
  });

  it('still refuses anything outside <stateDir>/profiles', async () => {
    await expect(wipeProfile(guest(join(real, 'elsewhere')), { stateDir: join(alias, '.notyours'), pool: new ChromePool() })).rejects.toThrow(/Refusing to wipe/);
  });
});
