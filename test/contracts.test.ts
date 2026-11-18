import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BoundarySchema,
  ConfigSchema,
  IdentitySchema,
  ProbeResultSchema,
  TOKEN_RE,
} from '../src/schemas.js';
import { findTokens, makeToken } from '../src/shared/token.js';
import { redactIdentity } from '../src/shared/redact.js';
import { mockBoundary, mockConfig, mockHeldResult, mockIdentities, mockLeakResult } from '../src/mocks/fixtures.js';
import { createEngine, createRatchet, createReport } from '../src/index.js';

describe('contracts', () => {
  it('fixtures satisfy the schemas', () => {
    for (const i of mockIdentities) expect(() => IdentitySchema.parse(i)).not.toThrow();
    expect(() => BoundarySchema.parse(mockBoundary)).not.toThrow();
    expect(() => ProbeResultSchema.parse(mockHeldResult)).not.toThrow();
    expect(() => ProbeResultSchema.parse(mockLeakResult)).not.toThrow();
  });

  it('config applies defaults', () => {
    expect(ConfigSchema.parse({ baseUrl: 'http://localhost:3000' })).toEqual({
      baseUrl: 'http://localhost:3000',
      allowHosts: ['localhost', '127.0.0.1'],
      parallel: true,
      liveCapture: true,
      creditFloor: 300,
      maxAttempts: 3,
    });
    expect(mockConfig.creditFloor).toBe(300);
  });

  it('tokens: NY-<ID>-<12 base32>, tied to the identity id', () => {
    const t = makeToken('alice');
    expect(t).toMatch(TOKEN_RE);
    expect(t.startsWith('NY-ALICE-')).toBe(true);
    expect(TOKEN_RE.test('NY-ALICE-AAAAAAAAAAA1')).toBe(false); // 1 is not base32
    expect(TOKEN_RE.test('NY-alice-AAAAAAAAAAAA')).toBe(false);
    const base = mockIdentities[0]!;
    expect(IdentitySchema.safeParse({ ...base, token: 'NY-BOB-BBBBBBBBBBBB' }).success).toBe(false);
  });

  it('findTokens scans text and dedupes', () => {
    expect(findTokens('x NY-BOB-BBBBBBBBBBBB y NY-BOB-BBBBBBBBBBBB {"t":"NY-ALICE-AAAAAAAAAAAA"}')).toEqual([
      'NY-BOB-BBBBBBBBBBBB',
      'NY-ALICE-AAAAAAAAAAAA',
    ]);
  });

  it('redactIdentity never exposes the password', () => {
    const r = redactIdentity(mockIdentities[0]!);
    expect(JSON.stringify(r)).not.toContain('fake-pw-alice');
    expect(r.password).toBe('[REDACTED]');
    expect('password' in redactIdentity(mockIdentities[2]!)).toBe(false);
  });

  it('mocks return schema-valid data', async () => {
    const result = await createEngine().runBoundary(mockBoundary, mockIdentities, mockConfig);
    expect(ProbeResultSchema.parse(result).boundaryId).toBe(mockBoundary.id);
    const ratchet = createRatchet();
    await ratchet.lock(mockBoundary, result);
    const replayed = await ratchet.replay(mockIdentities);
    expect(replayed).toHaveLength(1);
    for (const r of replayed) ProbeResultSchema.parse(r);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-contracts-'));
    expect(createReport().write(replayed, outDir)).toBe(path.join(outDir, 'report.html'));
  });
});
