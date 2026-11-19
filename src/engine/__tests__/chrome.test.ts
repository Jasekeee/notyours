import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChromePool, chromePath, killLiveChromes } from '../chrome.js';
import type { Identity } from '../../types.js';
import { freePortRange, killChromesUsing } from './test-ports.js';

const dir = mkdtempSync(join(tmpdir(), 'ny-chrome-'));
afterAll(() => { killLiveChromes(); killChromesUsing(dir); rmSync(dir, { recursive: true, force: true }); });

const ident = (id: string, port: number): Identity => ({
  id, role: 'viewer', plan: null, token: `NY-${id.toUpperCase()}-AAAAAAAAAAAA`, cdpPort: port, userDataDir: join(dir, id),
});

describe('chrome', () => {
  it('honours NOTYOURS_CHROME', () => {
    expect(chromePath({ NOTYOURS_CHROME: '/x/chrome' })).toBe('/x/chrome');
  });

  it('launches one headless Chrome per identity and shuts them down', async () => {
    const base = await freePortRange(2);
    const pool = new ChromePool({ headful: false });
    const [a, b] = await Promise.all([pool.get(ident('ca', base)), pool.get(ident('cb', base + 1))]);
    expect(a.endpoint).toBe(`http://127.0.0.1:${base}`);
    for (const h of [a, b]) {
      const v = (await (await fetch(`${h.endpoint}/json/version`)).json()) as { Browser: string };
      expect(v.Browser).toMatch(/Chrome/);
    }
    expect(await pool.get(ident('ca', base))).toBe(a); // reused, not relaunched
    await expect(pool.get(ident('dup', base))).rejects.toThrow(/already has a CDP endpoint/);
    await pool.closeAll();
    await expect(fetch(`${a.endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }, 60_000);
});
