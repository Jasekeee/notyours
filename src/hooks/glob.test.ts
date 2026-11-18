import { describe, expect, it } from 'vitest';
import { matchesGlob, toProjectPath } from './glob.js';

describe('matchesGlob', () => {
  const cases: [string, string, boolean][] = [
    ['src/app/api/notes/route.ts', 'src/app/api/notes/**', true],
    ['src/app/api/notes/[id]/route.ts', 'src/app/api/notes/**', true],
    ['src/app/api/notes', 'src/app/api/notes/**', true],
    ['src/app/api/notesx/route.ts', 'src/app/api/notes/**', false],
    ['src/app/api/users/route.ts', 'src/app/api/notes/**', false],
    ['src/a.ts', 'src/*.ts', true],
    ['src/deep/a.ts', 'src/*.ts', false],
    ['src/deep/a.ts', 'src/**/*.ts', true],
    ['src/a.ts', 'src/**/*.ts', true],
    ['lib/x.js', '**/*.js', true],
    ['x.js', '**/*.js', true],
    ['src/db.ts', 'src/db.{ts,js}', true],
    ['src/db.js', 'src/db.{ts,js}', true],
    ['src/db.py', 'src/db.{ts,js}', false],
    ['src/a1.ts', 'src/a?.ts', true],
    ['src/a1.ts', 'src/a[0-9].ts', true],
    ['src/ab.ts', 'src/a[!0-9].ts', true],
    ['server/auth.ts', 'server/auth.ts', true],
    ['server/auth/index.ts', 'server/auth', true],
    ['server/auth.tsx', 'server/auth.ts', false],
    ['server/auth.ts', './server/auth.ts', true],
    ['a+b/c.ts', 'a+b/*.ts', true],
    ['axb/c.ts', 'a.b/*.ts', false],
  ];
  for (const [file, glob, want] of cases) {
    it(`${glob} ${want ? 'matches' : 'does not match'} ${file}`, () => expect(matchesGlob(file, glob)).toBe(want));
  }
});

describe('toProjectPath', () => {
  it('makes absolute paths project-relative', () => expect(toProjectPath('/p', '/p/src/a.ts')).toBe('src/a.ts'));
  it('resolves relative paths against the project', () => expect(toProjectPath('/p', 'src/a.ts')).toBe('src/a.ts'));
  it('returns undefined outside the project', () => expect(toProjectPath('/p', '/q/a.ts')).toBeUndefined());
  it('returns undefined for a sibling that shares a prefix', () => expect(toProjectPath('/p', '/p2/a.ts')).toBeUndefined());
});
