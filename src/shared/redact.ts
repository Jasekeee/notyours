import type { Identity } from '../types.js';

export const REDACTED = '[REDACTED]' as const;

/** Identity safe to log, print or write to a report: the password is never included. */
export type LoggableIdentity = Omit<Identity, 'password'> & { password?: typeof REDACTED };

export function redactIdentity(identity: Identity): LoggableIdentity {
  const { password, ...rest } = identity;
  return password === undefined ? rest : { ...rest, password: REDACTED };
}
