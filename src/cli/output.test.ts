import { describe, expect, it } from 'vitest';
import { DEFAULT_FIX, fixLine, kv, table } from './output.js';

describe('output helpers', () => {
  it('table aligns columns and keeps ANSI colour out of the width', () => {
    const out = table(['boundary', 'verdict'], [['\x1b[31mnotes-cross-user\x1b[0m', 'LEAK_VISIBLE'], ['b2', 'HELD']]);
    const [head, rule, r1, r2] = out.split('\n');
    expect(head).toBe('boundary          verdict'); // 'notes-cross-user' is 16 wide
    expect(rule).toBe('----------------  ------------');
    const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain(r1!).indexOf('LEAK_VISIBLE')).toBe(head!.indexOf('verdict'));
    expect(plain(r2!).indexOf('HELD')).toBe(head!.indexOf('verdict'));
  });

  it('every error ends with a how-to-fix line; the generic one when the error has none', () => {
    expect(fixLine('run `notyours init`')).toBe('  how to fix: run `notyours init`');
    expect(fixLine(undefined)).toBe(`  how to fix: ${DEFAULT_FIX}`);
  });

  it('kv aligns keys', () => {
    expect(kv([['framework', 'express'], ['port', '4000']])).toBe('  framework  express\n  port       4000');
  });
});
