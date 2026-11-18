// The demo's .notyours files must parse with the frozen schemas (no extra fields).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BoundarySchema, ConfigSchema } from '../../src/schemas.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.notyours');
const read = (f) => parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const files = fs.readdirSync(path.join(dir, 'boundaries')).filter((f) => f.endsWith('.yaml')).sort();

describe('demo/.notyours', () => {
  it('config.yaml targets Jotter on 3077', () => {
    expect(ConfigSchema.parse(read('config.yaml')).baseUrl).toBe('http://127.0.0.1:3077');
  });

  it('has the four boundaries B1-B4, one per kind', () => {
    const kinds = files.map((f) => read(path.join('boundaries', f)).kind);
    expect(kinds).toEqual(['cross-user', 'guest', 'plan-gate', 'sweep']);
  });

  it.each(files)('%s matches BoundarySchema exactly', (f) => {
    const b = read(path.join('boundaries', f));
    expect(() => BoundarySchema.strict().parse(b)).not.toThrow();
    for (const s of b.surface) expect(fs.existsSync(path.join(dir, '..', s)), s).toBe(true);
  });
});
