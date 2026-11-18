// Report fixtures: a realistic mixed run (2 leaks, 1 held, 1 harness). All values are fake.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockBoundary, mockIdentities, mockKaneRun } from '../../mocks/fixtures.js';
import type { Boundary, Identity, ProbeResult } from '../../types.js';

export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SCREENSHOT = 'bob-sees-note.png';

export const fixtureBoundaries: Boundary[] = [
  mockBoundary,
  {
    ...mockBoundary,
    id: 'invoices-cross-user',
    targets: { ui: ['{{invoice_url}}'], api: ['http://127.0.0.1:3000/api/invoices/{{invoice_id}}'] },
    create: { objective: "Create an invoice with memo '{{token}}', store its URL as 'invoice_url'", store: ['invoice_url', 'invoice_id'] },
    surface: ['src/routes/invoices.ts'],
    locked: true,
  },
  {
    ...mockBoundary,
    id: 'export-plan-gate',
    kind: 'plan-gate',
    owner: 'free_user',
    viewer: 'free_user',
    proAction: { objective: 'Export all notes as CSV' },
    surface: ['src/routes/export.ts'],
  },
  { ...mockBoundary, id: 'profile-guest', kind: 'guest', viewer: 'guest', surface: ['src/routes/profile.ts'] },
];

const bobRun = { ...mockKaneRun, identity: 'bob', creditsConsumed: 0, durationS: 0.8, objective: 'visit targets', testUrl: 'https://kane.example.test/tests/bob-1' };

export const fixtureResults: ProbeResult[] = [
  {
    boundaryId: 'notes-cross-user',
    verdict: 'LEAK_VISIBLE',
    controls: { ownerSeesOwnToken: true, viewerSeesOwnToken: true },
    hits: [{ token: 'NY-ALICE-AAAAAAAAAAAA', where: 'dom', url: 'http://127.0.0.1:3000/notes/7', snippet: '<h1>NY-ALICE-AAAAAAAAAAAA</h1><p>Groceries <script>x</script></p>' }],
    screenshots: [SCREENSHOT, 'missing-shot.png'],
    kaneRuns: [{ ...mockKaneRun, testUrl: 'https://kane.example.test/tests/alice-1' }, bobRun],
    ts: '2026-11-18T12:00:00.000Z',
  },
  {
    boundaryId: 'invoices-cross-user',
    verdict: 'LEAK_PAYLOAD',
    controls: { ownerSeesOwnToken: true, viewerSeesOwnToken: true },
    hits: [{ token: 'NY-ALICE-AAAAAAAAAAAA', where: 'network', url: 'http://127.0.0.1:3000/api/invoices/12', snippet: '{"memo":"NY-ALICE-AAAAAAAAAAAA","owner":"alice","pw":"fake-pw-alice"}' }], // notyours:allow-secret (fake fixture)
    screenshots: [],
    kaneRuns: [{ ...mockKaneRun, creditsConsumed: 0, durationS: 0.7 }, bobRun],
    ts: '2026-11-18T12:00:05.000Z',
  },
  {
    boundaryId: 'profile-guest',
    verdict: 'HELD',
    controls: { ownerSeesOwnToken: true, viewerSeesOwnToken: true },
    hits: [],
    screenshots: [],
    kaneRuns: [mockKaneRun, { ...bobRun, identity: 'guest', creditsConsumed: 12.3, durationS: 22 }],
    ts: '2026-11-18T12:01:00.000Z',
  },
  {
    boundaryId: 'export-plan-gate',
    verdict: 'HARNESS_BROKEN',
    controls: { ownerSeesOwnToken: true, viewerSeesOwnToken: false },
    hits: [],
    screenshots: [],
    kaneRuns: [{ ...mockKaneRun, identity: 'free_user', status: 'failed', reason: 'stuck.ap_stuck' }],
    ts: '2026-11-18T12:02:00.000Z',
  },
];

export const fixtureIdentities: Identity[] = mockIdentities;
