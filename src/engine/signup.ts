// Sign up (or log in) each identity once in its own Chrome profile, so later probes start signed in.
import type { Identity } from '../types.js';
import { safeObjectiveUrl } from './probes.js';
import type { KaneOutcome, KaneRunner, KaneRunOptions } from './kane.js';

// The base URL is written out (kane-cli needs a start URL it can see; a {{base_url}} placeholder is flaky).
// No "verify" step: kane-cli 0.10.0 replays analyze->assert chains without their value, so a recorded
// assertion fails on replay even when the login worked. The oracle's positive controls prove the session.
export const signupObjective = (baseUrl: string) =>
  `Go to ${baseUrl}/signup, sign up with email {{email}} and password {{password}}, then wait for the next page to load`;
export const loginObjective = (baseUrl: string) =>
  `Go to ${baseUrl}/login, log in with email {{email}} and password {{password}}, then wait for the next page to load`;

/** Things a Kane persona cannot get past on its own. */
const UNSUPPORTED = /captcha|i'?m not a robot|oauth|sign in with (google|github|apple|microsoft)|social login|sms|text message|verification code|one[- ]time (pass)?code|\botp\b|2fa|two[- ]factor/i;

export class UnsupportedSignupError extends Error {}

function vars(identity: Identity, baseUrl: string) {
  if (!identity.email || !identity.password) throw new Error(`Identity ${identity.id} has no email/password to sign up with.`);
  return {
    base_url: baseUrl.replace(/\/+$/, ''),
    email: identity.email,
    password: { value: identity.password, secret: true },
  };
}

async function authRun(kind: 'signup' | 'login', identity: Identity, runner: KaneRunner, opts: KaneRunOptions): Promise<KaneOutcome> {
  const base = safeObjectiveUrl(opts.cfg.baseUrl.replace(/\/+$/, '') + '/').replace(/\/+$/, '');
  const out = await runner(kind === 'signup' ? signupObjective(base) : loginObjective(base), identity, vars(identity, opts.cfg.baseUrl), opts);
  if (out.run.status !== 'passed' && UNSUPPORTED.test(`${out.text}\n${out.run.reason ?? ''}`)) {
    throw new UnsupportedSignupError(
      `Automatic ${kind} for "${identity.id}" is not supported: the app requires a captcha, OAuth-only login or an SMS/one-time code. ` +
        'Create the accounts yourself and pass --users instead.',
    );
  }
  return out;
}

/** One authoring run: sign the identity up in its Chrome. Guests are skipped. */
export function signup(identity: Identity, runner: KaneRunner, opts: KaneRunOptions): Promise<KaneOutcome> {
  return authRun('signup', identity, runner, opts);
}

/** One authoring run: log an imported (--users) identity in. */
export function login(identity: Identity, runner: KaneRunner, opts: KaneRunOptions): Promise<KaneOutcome> {
  return authRun('login', identity, runner, opts);
}
