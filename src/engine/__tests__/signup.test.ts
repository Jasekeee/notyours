import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../schemas.js';
import { mockIdentities } from '../../mocks/fixtures.js';
import type { KaneOutcome, KaneRunner } from '../kane.js';
import { SIGNUP_OBJECTIVE, UnsupportedSignupError, signup } from '../signup.js';

const cfg = ConfigSchema.parse({ baseUrl: 'http://127.0.0.1:3000/' });
const opts = { cfg, stateDir: '/tmp/unused' };
const alice = mockIdentities[0]!;

const outcome = (status: 'passed' | 'failed', text: string): KaneOutcome => ({
  run: { objective: '', identity: 'alice', status, exitCode: status === 'passed' ? 0 : 1, finalState: {}, creditsConsumed: 10, durationS: 1 },
  stored: {},
  text,
});

describe('signup', () => {
  it('passes the signup objective with base_url (no trailing slash) and a secret password', async () => {
    let seen: Parameters<KaneRunner> | undefined;
    const runner: KaneRunner = async (...args) => { seen = args; return outcome('passed', 'Signed in'); };
    await signup(alice, runner, opts);
    expect(seen?.[0]).toBe(SIGNUP_OBJECTIVE);
    expect(seen?.[2]).toEqual({ base_url: 'http://127.0.0.1:3000', email: alice.email, password: { value: alice.password, secret: true } });
  });

  it.each(['The form shows a reCAPTCHA challenge', 'Only "Sign in with Google" (OAuth) is offered', 'A 6-digit SMS code was requested'])(
    'stops with a clear message on: %s', async (text) => {
      const runner: KaneRunner = async () => outcome('failed', text);
      await expect(signup(alice, runner, opts)).rejects.toThrow(UnsupportedSignupError);
      await expect(signup(alice, runner, opts)).rejects.toThrow(/not supported.*pass --users instead/);
    },
  );

  it('returns an ordinary failure untouched', async () => {
    const runner: KaneRunner = async () => outcome('failed', 'Submit button was disabled');
    expect((await signup(alice, runner, opts)).run.status).toBe('failed');
  });
});
