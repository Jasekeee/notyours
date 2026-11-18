import path from 'node:path';

/** Every on-disk location the ratchet and the hooks use, relative to one project directory. */
export interface NotyoursPaths {
  root: string;
  dir: string;
  config: string;
  /** Single-file boundary store: a YAML list, or `{ boundaries: [...] }`. */
  boundariesFile: string;
  /** Directory store: one boundary (or a list) per .yaml/.yml/.json file. */
  boundariesDir: string;
  /** Identities without passwords: tokens, CDP ports, profile dirs. */
  identities: string;
  /** Passwords (gitignored); merged over identities.json by id. */
  secrets: string;
  map: string;
  dirty: string;
  attempts: string;
  tests: string;
  runs: string;
  /** Append-only log of every Kane run's credits_consumed. */
  creditsLog: string;
  escalation: string;
  /** Where kane-cli writes `run --name X` tests when run from `root`. */
  kaneTests: string;
}

export function notyoursPaths(projectDir: string): NotyoursPaths {
  const root = path.resolve(projectDir);
  const dir = path.join(root, '.notyours');
  return {
    root,
    dir,
    config: path.join(dir, 'config.yaml'),
    boundariesFile: path.join(dir, 'boundaries.yaml'),
    boundariesDir: path.join(dir, 'boundaries'),
    identities: path.join(dir, 'identities.json'),
    secrets: path.join(dir, 'secrets.json'),
    map: path.join(dir, 'map.json'),
    dirty: path.join(dir, 'dirty.json'),
    attempts: path.join(dir, 'attempts.json'),
    tests: path.join(dir, 'tests'),
    runs: path.join(dir, 'runs'),
    creditsLog: path.join(dir, 'runs', 'credits.jsonl'),
    escalation: path.join(root, 'ESCALATION.md'),
    kaneTests: path.join(root, '.testmuai', 'tests'),
  };
}

/** Kane test name for one identity of one boundary. Boundary ids cannot contain `_`, so the split is unambiguous. */
export function testName(boundaryId: string, identityId: string): string {
  return `${boundaryId}_${identityId}`;
}

export function testFile(p: NotyoursPaths, boundaryId: string, identityId: string): string {
  return path.join(p.tests, `${testName(boundaryId, identityId)}_test.md`);
}

/** kane-cli keeps a test's replay recordings in `output-<name>/` next to `<name>_test.md`. */
export function testOutputDir(testsDir: string, name: string): string {
  return path.join(testsDir, `output-${name}`);
}
