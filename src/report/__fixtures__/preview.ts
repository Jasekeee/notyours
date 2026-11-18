// Dev helper: npx tsx src/report/__fixtures__/preview.ts <outDir>  -> renders the fixture report.
import { createReport } from '../index.js';
import { FIXTURE_DIR, fixtureBoundaries, fixtureIdentities, fixtureResults } from './results.js';

const out = process.argv[2] ?? 'report-preview';
console.log(
  createReport({
    boundaries: fixtureBoundaries,
    identities: fixtureIdentities,
    baseDir: FIXTURE_DIR,
    startedAt: '2026-11-18T12:00:00.000Z',
    finishedAt: '2026-11-18T12:02:41.000Z',
  }).write(fixtureResults, out),
);
