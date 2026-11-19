import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { demoStartCommand, packagedDemoDir } from './demo.js';

// A demo copy lands inside the user's folder, whose package.json may say "commonjs". The demo's own package.json
// keeps its ESM files loading as modules, and it must not add a start script (the server.js fallback still applies).
describe('the packaged demo runs from a copy in any folder', () => {
  it('is an ES module with no start script, and starts server.js', () => {
    const dir = packagedDemoDir();
    expect(dir).toBeDefined();
    const pkg = JSON.parse(fs.readFileSync(path.join(dir!, 'package.json'), 'utf8')) as { type?: string; scripts?: unknown };
    expect(pkg.type).toBe('module');
    expect(pkg.scripts).toBeUndefined();
    expect(demoStartCommand(dir!).args).toEqual(['server.js']);
  });
});
