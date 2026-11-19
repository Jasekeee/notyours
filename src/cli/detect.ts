// `notyours init` detection: what kind of app is here, how to start it, which port, and whether Kane can sign
// its personas up at all. Static and fast (reads package.json and source files; no network, no credits).
import fs from 'node:fs';
import path from 'node:path';

export type Framework = 'next' | 'express' | 'node' | 'unknown';
export type BlockerKind = 'captcha' | 'oauth-only' | 'sms';

export interface Blocker {
  kind: BlockerKind;
  /** Project-relative file that showed it. */
  file: string;
  /** Plain-English reason, for the refusal. */
  why: string;
}

export interface Detection {
  framework: Framework;
  hasPackageJson: boolean;
  /** npm script to start the app: `start`, else `dev`. Undefined when there is none. */
  startScript?: string;
  /** Port the app listens on (from its scripts, its code, or the framework default). */
  port: number;
  portSource: 'script' | 'code' | 'default';
  blockers: Blocker[];
  /** Source files read (for the summary line). */
  filesScanned: number;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', '.notyours', '.testmuai', '.cache']);
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const MAX_FILES = 3000;
const MAX_BYTES = 512 * 1024;

const CAPTCHA_RE = /recaptcha|hcaptcha|turnstile|\bcaptcha\b/i;
const OAUTH_RE = /passport-(?:google|github|facebook|twitter|apple)|(?:Google|GitHub|Facebook|Apple|Twitter)(?:Provider|Strategy)|oauth|sign in with (?:google|github|apple|microsoft)/i;
const PASSWORD_RE = /\bpassword\b|passwordHash|password_hash|bcrypt|scrypt/i;
const SMS_RE = /twilio|sendSms|sendsms|\bsms\b|one[- ]time (?:pass)?code|\botp\b|verification code/i;

/** Source files under `root` (skips dependencies and build output). Capped so a huge repo stays fast. */
function codeFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.isSymbolicLink()) visit(full, depth + 1);
      } else if (e.isFile() && CODE_EXT.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        out.push(full);
      }
    }
  };
  visit(root, 0);
  return out;
}

function readPackage(root: string): { scripts: Record<string, string>; deps: Set<string>; present: boolean } {
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return { scripts: {}, deps: new Set(), present: false };
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return {
      scripts: pkg.scripts ?? {},
      deps: new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]),
      present: true,
    };
  } catch {
    return { scripts: {}, deps: new Set(), present: true };
  }
}

/** A port written into an npm script: `-p 3001`, `--port=3001`, `PORT=3001 next dev`. */
export function portFromScript(script: string): number | undefined {
  const m = /(?:-p\s+|--port[=\s]+|\bPORT=)(\d{2,5})\b/.exec(script);
  return m ? Number(m[1]) : undefined;
}

/** A port written into code: `process.env.PORT || 4000`, `.listen(5000`, `const PORT = 4100`. */
export function portFromCode(src: string): number | undefined {
  const m = /PORT\s*(?:\|\||\?\?)\s*(\d{2,5})|\.listen\(\s*(\d{2,5})\s*[,)]|\bconst\s+PORT\s*=\s*(\d{2,5})\b/.exec(src);
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v ? Number(v) : undefined;
}

export function detectBlockers(files: Array<{ rel: string; src: string }>): Blocker[] {
  const blockers: Blocker[] = [];
  const hasPassword = files.some((f) => PASSWORD_RE.test(f.src));
  for (const f of files) {
    if (CAPTCHA_RE.test(f.src)) {
      blockers.push({ kind: 'captcha', file: f.rel, why: 'a CAPTCHA (Kane cannot solve it)' });
      break;
    }
  }
  if (!hasPassword) {
    const oauth = files.find((f) => OAUTH_RE.test(f.src));
    if (oauth) blockers.push({ kind: 'oauth-only', file: oauth.rel, why: 'OAuth sign-in with no email and password' });
    const sms = files.find((f) => SMS_RE.test(f.src));
    if (sms) blockers.push({ kind: 'sms', file: sms.rel, why: 'an SMS or one-time-code sign-in with no email and password' });
  }
  return blockers;
}

export function detectProject(root: string): Detection {
  const pkg = readPackage(root);
  const framework: Framework = pkg.deps.has('next') ? 'next' : pkg.deps.has('express') ? 'express' : pkg.present ? 'node' : 'unknown';
  const startScript = pkg.scripts.start !== undefined ? 'start' : pkg.scripts.dev !== undefined ? 'dev' : undefined;
  const files = codeFiles(root).map((abs) => {
    let src = '';
    try {
      if (fs.statSync(abs).size <= MAX_BYTES) src = fs.readFileSync(abs, 'utf8');
    } catch {
      /* unreadable: skip */
    }
    return { rel: path.relative(root, abs).split(path.sep).join('/'), src };
  });
  // Port precedence: an explicit script flag, then the code, then the framework default.
  const scriptPort = [pkg.scripts.start, pkg.scripts.dev].map((s) => (s ? portFromScript(s) : undefined)).find((p) => p !== undefined);
  const codePort = files.map((f) => portFromCode(f.src)).find((p) => p !== undefined);
  const port = scriptPort ?? codePort ?? 3000;
  const portSource = scriptPort !== undefined ? 'script' : codePort !== undefined ? 'code' : 'default';
  return {
    framework,
    hasPackageJson: pkg.present,
    ...(startScript ? { startScript } : {}),
    port,
    portSource,
    blockers: detectBlockers(files),
    filesScanned: files.length,
  };
}

/** The `app.start` command for a detection, as written to config.yaml (undefined: nothing to start). */
export function startCommandFor(d: Detection): string | undefined {
  if (!d.startScript) return undefined;
  return d.startScript === 'start' ? 'npm start' : `npm run ${d.startScript}`;
}

/** The refusal text for an app Kane can't sign up. Always ends with what to do instead. */
export function blockerMessage(blockers: Blocker[]): { message: string; fix: string } {
  const first = blockers[0]!;
  return {
    message: `Refusing to sign personas up automatically: this app uses ${first.why} (${first.file}).`,
    fix: 'create the test accounts yourself (email + password, one per persona), put them in users.yaml, then run `notyours init --users users.yaml`.',
  };
}
