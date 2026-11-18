import { customAlphabet } from 'nanoid';
import { BASE32_ALPHABET, TOKEN_SCAN_RE } from '../schemas.js';

const random12 = customAlphabet(BASE32_ALPHABET, 12);

/** New canary token for an identity id: makeToken('alice') -> NY-ALICE-K7Q2MZX4P3RA */
export function makeToken(identityId: string): string {
  return `NY-${identityId.toUpperCase()}-${random12()}`;
}

/** All canary tokens found in a piece of text (deduplicated, in order of first appearance). */
export function findTokens(text: string): string[] {
  return [...new Set(text.match(TOKEN_SCAN_RE) ?? [])];
}
