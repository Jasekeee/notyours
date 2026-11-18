// Fixed sample data so each module can be built and tested alone. All values are fake.
import { ConfigSchema } from '../schemas.js';
import type { Boundary, Config, Identity, KaneRun, ProbeResult } from '../types.js';

export const MOCK_TS = '2026-11-18T12:00:00.000Z';

export const mockIdentities: Identity[] = [
  { id: 'alice', role: 'owner', email: 'alice@example.test', password: 'fake-pw-alice', plan: 'pro', token: 'NY-ALICE-AAAAAAAAAAAA', cdpPort: 9301, userDataDir: '/tmp/ny-alice' }, // notyours:allow-secret (fake fixture)
  { id: 'bob', role: 'viewer', email: 'bob@example.test', password: 'fake-pw-bob', plan: 'free', token: 'NY-BOB-BBBBBBBBBBBB', cdpPort: 9302, userDataDir: '/tmp/ny-bob' }, // notyours:allow-secret (fake fixture)
  { id: 'guest', role: 'guest', plan: null, token: 'NY-GUEST-CCCCCCCCCCCC', cdpPort: 9303, userDataDir: '/tmp/ny-guest' },
  { id: 'free_user', role: 'free', email: 'free@example.test', password: 'fake-pw-free', plan: 'free', token: 'NY-FREE_USER-DDDDDDDDDDDD', cdpPort: 9304, userDataDir: '/tmp/ny-free' }, // notyours:allow-secret (fake fixture)
];

export const mockConfig: Config = ConfigSchema.parse({ baseUrl: 'http://127.0.0.1:3000' });

export const mockBoundary: Boundary = {
  id: 'notes-cross-user',
  kind: 'cross-user',
  owner: 'alice',
  viewer: 'bob',
  create: {
    objective: "Go to http://127.0.0.1:3000/notes/new, create a note titled '{{token}}', save it, store the note URL as 'note_url'",
    store: ['note_url'],
  },
  targets: { ui: ['{{note_url}}'], api: ['http://127.0.0.1:3000/api/notes'] },
  expect: 'denied',
  surface: ['src/app/api/notes/**', 'src/app/notes/**'],
};

export const mockKaneRun: KaneRun = {
  objective: mockBoundary.create.objective,
  identity: 'alice',
  status: 'passed',
  exitCode: 0,
  finalState: {},
  creditsConsumed: 16,
  durationS: 41.5,
  reason: 'success.complete',
};

export const mockHeldResult: ProbeResult = {
  boundaryId: mockBoundary.id,
  verdict: 'HELD',
  controls: { ownerSeesOwnToken: true, viewerSeesOwnToken: true },
  hits: [],
  screenshots: [],
  kaneRuns: [mockKaneRun],
  ts: MOCK_TS,
};

export const mockLeakResult: ProbeResult = {
  ...mockHeldResult,
  verdict: 'LEAK_PAYLOAD',
  hits: [{ token: 'NY-ALICE-AAAAAAAAAAAA', where: 'network', url: 'http://127.0.0.1:3000/api/notes', snippet: '{"title":"NY-ALICE-AAAAAAAAAAAA","owner":"alice"}' }],
};
