// The demo's .notyours files must parse with the frozen schemas (no extra fields).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { BoundarySchema, ConfigSchema } from '../../src/schemas.ts';

/** Exactly the CC-1 field from CONTRACT_CHANGE.md on feat/engine. */
const ViewerOwnSchema = z.object({ ui: z.array(z.string()), api: z.array(z.string()) }).strict();

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
    // CC-1 (approved, not yet applied to src/schemas.ts) adds an optional viewerOwn. Until it lands,
    // check it against the CC-1 shape here and strict-parse everything else. Once BoundarySchema
    // has viewerOwn, the strict parse below already accepts it and this stays correct.
    const { viewerOwn, ...rest } = b;
    if (viewerOwn !== undefined) expect(() => ViewerOwnSchema.parse(viewerOwn)).not.toThrow();
    expect(() => BoundarySchema.strict().parse(rest)).not.toThrow();
    for (const s of b.surface) expect(fs.existsSync(path.join(dir, '..', s)), s).toBe(true);
  });

  it('B1 and B3 point viewerOwn at Bob\'s own note 1002', () => {
    for (const f of ['b1-cross-user.yaml', 'b3-plan-gate.yaml']) {
      expect(read(path.join('boundaries', f)).viewerOwn, f).toEqual({ ui: ['http://127.0.0.1:3077/notes/1002'], api: [] });
    }
  });
});
