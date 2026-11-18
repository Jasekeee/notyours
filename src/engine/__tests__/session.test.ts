// Persona sessions: first launch records a login (1 authoring run), later launches replay it (0 credits).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../schemas.js';
import type { Identity } from '../../types.js';
import type { KaneRunner } from '../kane.js';
import { loginTestName, sessionPool } from '../session.js';

const root = mkdtempSync(join(tmpdir(), 'ny-session-'));
const stateDir = join(root, '.notyours');
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
    const alice = ident('alice', 'owner', 9431);
    const guest = ident('guest', 'guest', 9432);

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
  }, 60_000);
});
