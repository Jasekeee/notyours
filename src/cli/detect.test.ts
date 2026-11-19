import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockerMessage, detectBlockers, detectProject, portFromCode, portFromScript, startCommandFor } from './detect.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ny-detect-'));

describe('project detection (notyours init)', () => {
  it('ports: from a script flag, from code, never from prose', () => {
    expect(portFromScript('next dev -p 3001')).toBe(3001);
    expect(portFromScript('vite --port=5173')).toBe(5173);
    expect(portFromScript('PORT=4500 node server.js')).toBe(4500);
    expect(portFromScript('node server.js')).toBeUndefined();
    expect(portFromCode('const PORT = process.env.PORT || 4000;')).toBe(4000);
    expect(portFromCode("app.listen(5000, '127.0.0.1')")).toBe(5000);
    expect(portFromCode('const x = 1;')).toBeUndefined();
  });

  it('a Next.js app: framework next, `npm run dev`, the script port wins over the default', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev -p 3100' }, dependencies: { next: '15.0.0' } }));
    const d = detectProject(root);
    expect(d.framework).toBe('next');
    expect(startCommandFor(d)).toBe('npm run dev');
    expect(d.port).toBe(3100);
    expect(d.portSource).toBe('script');
  });

  it('an Express app with PORT || 4000 in code (natural-app): `npm start`, port 4000 from code', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' }, dependencies: { express: '^4' } }));
    fs.writeFileSync(path.join(root, 'server.js'), 'const PORT = process.env.PORT || 4000;\n');
    const d = detectProject(root);
    expect(d).toMatchObject({ framework: 'express', startScript: 'start', port: 4000, portSource: 'code', blockers: [] });
    expect(startCommandFor(d)).toBe('npm start');
  });

  it('no package.json: unknown framework, default port 3000, nothing to start', () => {
    const root = tmp();
    const d = detectProject(root);
    expect(d).toMatchObject({ framework: 'unknown', hasPackageJson: false, port: 3000, portSource: 'default' });
    expect(startCommandFor(d)).toBeUndefined();
  });

  it('skips node_modules and build output when reading code', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'node_modules/lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/lib/captcha.js'), 'recaptcha');
    fs.writeFileSync(path.join(root, 'index.js'), 'const password = 1;');
    expect(detectProject(root).blockers).toEqual([]);
  });

  it('blockers: a CAPTCHA; OAuth with no password; SMS with no password. A password form clears OAuth and SMS', () => {
    expect(detectBlockers([{ rel: 'a.js', src: 'hcaptcha.render()' }])).toEqual([expect.objectContaining({ kind: 'captcha', file: 'a.js' })]);
    expect(detectBlockers([{ rel: 'auth.js', src: 'new GoogleStrategy({})' }])).toEqual([expect.objectContaining({ kind: 'oauth-only' })]);
    expect(detectBlockers([{ rel: 'auth.js', src: 'new GoogleStrategy({}); const password = 1' }])).toEqual([]);
    expect(detectBlockers([{ rel: 'sms.js', src: 'twilio.messages.create()' }])).toEqual([expect.objectContaining({ kind: 'sms' })]);
    expect(detectBlockers([{ rel: 'sms.js', src: 'twilio.messages.create(); const password = 1' }])).toEqual([]);
  });

  it('the refusal names the file, and says what to do instead', () => {
    const b = blockerMessage(detectBlockers([{ rel: 'views/login.html', src: 'recaptcha' }]));
    expect(b.message).toMatch(/CAPTCHA.*views\/login\.html/);
    expect(b.fix).toMatch(/notyours init --users users\.yaml/);
  });
});
