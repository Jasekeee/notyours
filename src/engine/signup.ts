// Sign up (or log in) each identity once in its own Chrome profile, so later probes start signed in.
import type { Identity } from '../types.js';
import type { KaneOutcome, KaneRunner, KaneRunOptions } from './kane.js';

export const SIGNUP_OBJECTIVE =
  'Go to {{base_url}}/signup, sign up with email {{email}} and password {{password}}, then verify you are signed in';
export const LOGIN_OBJECTIVE =
  'Go to {{base_url}}/login, log in with email {{email}} and password {{password}}, then verify you are signed in';

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
  const out = await runner(kind === 'signup' ? SIGNUP_OBJECTIVE : LOGIN_OBJECTIVE, identity, vars(identity, opts.cfg.baseUrl), opts);
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
