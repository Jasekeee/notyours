// Persona sessions: first launch records a login (1 authoring run), later launches replay it (0 credits).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../schemas.js';
import type { Identity } from '../../types.js';
import type { KaneRunner } from '../kane.js';
import { loginTestName, sessionPool } from '../session.js';
import { freePortRange, killChromesUsing } from './test-ports.js';

const root = mkdtempSync(join(tmpdir(), 'ny-session-'));
const stateDir = join(root, '.notyours');
let base = 0;
beforeAll(async () => { base = await freePortRange(16); });
afterAll(() => { killChromesUsing(root); rmSync(root, { recursive: true, force: true }); });

const ident = (id: string, role: Identity['role'], port: number): Identity => ({
  id, role, plan: null, token: `NY-${id.toUpperCase()}-AAAAAAAAAAAA`, cdpPort: port, userDataDir: join(stateDir, 'profiles', id),
  ...(role === 'guest' ? {} : { email: `${id}@x.test`, password: 'pw-test' }),
});

describe('session pool', () => {
  it('records a login once, then replays it; guests never log in', async () => {
    const authored: string[] = [];
    const replayed: string[] = [];
    // Fake kane-cli: "authoring" writes the recording kane-cli would leave in <cwd>/.testmuai/tests.
    const runner: KaneRunner = async (objective, identity, _vars, opts) => {
      authored.push(`${identity.id}:${opts.name}`);
      const dir = join(root, '.testmuai', 'tests');
      mkdirSync(join(dir, `output-${opts.name}`), { recursive: true });
      writeFileSync(join(dir, `${opts.name}_test.md`), '## Step 1\nlog in\n');
      writeFileSync(join(dir, `output-${opts.name}`, '.env.example'), 'LT_USERNAME=\n');
      return { run: { objective, identity: identity.id, status: 'passed', exitCode: 0, finalState: {}, creditsConsumed: 30, durationS: 1 }, stored: {}, text: '' };
    };
    const kane = {
      replay: async (req: { testPath: string; identity: string; variables?: Record<string, { value: string; secret?: boolean }> }) => {
        replayed.push(req.identity);
        expect(req.variables?.password).toEqual({ value: 'pw-test', secret: true }); // re-supplied at replay time
        return { run: { objective: 'replay', identity: req.identity, status: 'passed' as const, exitCode: 0, finalState: {}, creditsConsumed: 0, durationS: 0.4 }, authorDecisions: 0 };
      },
    };
    const opts = { cfg: ConfigSchema.parse({ baseUrl: 'http://127.0.0.1:1' }), stateDir, cwd: root, runner, kane, log: () => {} };
    const alice = ident('alice', 'owner', base + 1);
    const guest = ident('guest', 'guest', base + 2);

    const first = sessionPool(opts, { headful: false });
    await Promise.all([first.get(alice), first.get(guest)]);
    await first.closeAll();
    expect(authored).toEqual([`alice:${loginTestName('alice')}`]);
    // Kept inside the persona's own (guarded, gitignored) Chrome profile dir: it holds the typed password.
    const rec = join(stateDir, 'profiles', 'alice', 'notyours-login');
    expect(existsSync(join(rec, 'login_alice_test.md'))).toBe(true);
    expect(existsSync(join(stateDir, 'tests', 'login_alice_test.md'))).toBe(false);
    expect(existsSync(join(rec, 'output-login_alice', '.env.example'))).toBe(false); // stripped
    expect(existsSync(join(root, '.testmuai', 'tests', 'login_alice_test.md'))).toBe(false); // adopted (moved)

    const second = sessionPool(opts, { headful: false });
    await second.get(alice);
    await second.closeAll();
    expect(replayed).toEqual(['alice']);
    expect(authored).toHaveLength(1); // no new authoring run

    // During a replay (Stop hook), a failing login replay is never re-recorded: no credits.
    const failing = { replay: async (req: { identity: string }) => ({ run: { objective: 'replay', identity: req.identity, status: 'failed' as const, exitCode: 1, finalState: {}, creditsConsumed: 0, durationS: 1 }, authorDecisions: 0 }) };
    const third = sessionPool({ ...opts, kane: failing, rerecordOnFailure: false }, { headful: false });
    await third.get(alice);
    await third.closeAll();
    expect(authored).toHaveLength(1);

    // Already signed in (its own page shows its token): no login replay at all (none failed, 0 credits).
    const checked: string[][] = [];
    const fourth = sessionPool({ ...opts, kane: failing, rerecordOnFailure: false, ownPages: { alice: ['http://127.0.0.1:1/notes/6'] },
      isSignedIn: async (_i, _h, urls) => { checked.push(urls); return true; } }, { headful: false });
    const before = replayed.length;
    await fourth.get(alice);
    await fourth.closeAll();
    expect(checked).toEqual([['http://127.0.0.1:1/notes/6']]);
    expect(replayed.length).toBe(before);
    // Not signed in: the recorded login replays as before.
    const fifth = sessionPool({ ...opts, ownPages: { alice: ['http://127.0.0.1:1/notes/6'] }, isSignedIn: async () => false }, { headful: false });
    await fifth.get(alice);
    await fifth.closeAll();
    expect(replayed.length).toBe(before + 1);
  }, 60_000);
});
