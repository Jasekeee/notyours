import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../schemas.js';
import { mockIdentities } from '../../mocks/fixtures.js';
import { CreditFloorError, lastRunEnd, runKane, statusFromExit } from '../kane.js';

const fake = fileURLToPath(new URL('./fake-kane.mjs', import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), 'ny-kane-'));
const cfg = ConfigSchema.parse({ baseUrl: 'http://127.0.0.1:3000', creditFloor: 300 });
const alice = mockIdentities[0]!;
const ENV = ['FAKE_KANE_DEBUG', 'NOTYOURS_KANE_BIN', 'FAKE_KANE_BALANCE', 'FAKE_KANE_EXIT', 'FAKE_KANE_NO_RUN_END'];

beforeAll(() => chmodSync(fake, 0o755));
afterEach(() => { for (const k of ENV) delete process.env[k]; });
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

describe('kane', () => {
  it('maps exit codes', () => {
    expect([0, 1, 2, 3].map((c) => statusFromExit(c, false))).toEqual(['passed', 'failed', 'error', 'timeout']);
    expect(statusFromExit(undefined, true)).toBe('timeout');
  });

  it('takes the last run_end and skips noise', () => {
    const out = ['Update available', '{"type":"run_end","status":"failed"}', '{"step":1}', '{"type":"run_end","status":"passed"}', '{"type":"run_'].join('\n');
    expect(lastRunEnd(out)?.status).toBe('passed');
  });

  it('runs with a 0600 vars file, deletes it, parses run_end, logs credits', async () => {
    process.env.NOTYOURS_KANE_BIN = fake;
    const out = await runKane('Go to {{base_url}}', alice, { base_url: 'http://127.0.0.1:3000', password: { value: 'x', secret: true } }, { cfg, stateDir, cwd: stateDir });
    expect(out.run).toMatchObject({ status: 'passed', exitCode: 0, creditsConsumed: 12.5, durationS: 1.5, identity: 'alice', reason: 'success.complete' });
    expect(out.stored).toEqual({ item_url: 'http://127.0.0.1:1/notes/1' });
    const log = readFileSync(join(stateDir, 'credits.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.at(-1)).toMatchObject({ identity: 'alice', credits: 12.5, status: 'passed' });
    expect(JSON.stringify(log)).not.toContain('"x"'); // password value never logged
  });

  it('vars file is 0600 and removed after; password secret; CDP = identity port; agent + timeout flags', async () => {
    process.env.NOTYOURS_KANE_BIN = fake;
    const debugFile = join(stateDir, 'debug.json');
    process.env.FAKE_KANE_DEBUG = debugFile;
    await runKane('x', alice, { base_url: 'http://127.0.0.1:3000', password: { value: 'pw', secret: true } }, { cfg, stateDir, cwd: stateDir });
    const d = JSON.parse(readFileSync(debugFile, 'utf8'));
    expect(d).toMatchObject({ mode: '600', varNames: ['base_url', 'password'], passwordSecret: true, cdp: 'http://127.0.0.1:9301', timeout: '240', agent: true });
    expect(existsSync(d.varsFile)).toBe(false);
  });

  it('refuses to start below the credit floor', async () => {
    process.env.NOTYOURS_KANE_BIN = fake;
    process.env.FAKE_KANE_BALANCE = '120.5';
    await expect(runKane('x', alice, {}, { cfg, stateDir })).rejects.toBeInstanceOf(CreditFloorError);
  });

  it('exit 1 -> failed; exit 0 without run_end -> error', async () => {
    process.env.NOTYOURS_KANE_BIN = fake;
    process.env.FAKE_KANE_EXIT = '1';
    expect((await runKane('x', alice, {}, { cfg, stateDir, cwd: stateDir })).run.status).toBe('failed');
    process.env.FAKE_KANE_EXIT = '0';
    process.env.FAKE_KANE_NO_RUN_END = '1';
    expect((await runKane('x', alice, {}, { cfg, stateDir, cwd: stateDir })).run.status).toBe('error');
  });
});

