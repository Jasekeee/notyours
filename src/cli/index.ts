#!/usr/bin/env node
// CLI stub wired to the mocks. Owned by feat/cli; commands and options will grow there.
import { Command } from 'commander';
import pc from 'picocolors';
import pkg from '../../package.json' with { type: 'json' };
import { createEngine } from '../engine/index.js';
import { createRatchet } from '../ratchet/index.js';
import { createReport } from '../report/index.js';
import { mockBoundary, mockConfig, mockIdentities } from '../mocks/fixtures.js';

const program = new Command();
program.name('notyours').description(pkg.description).version(pkg.version);

program
  .command('probe')
  .description('Probe boundaries with Kane personas (mock)')
  .action(async () => {
    const result = await createEngine().runBoundary(mockBoundary, mockIdentities, mockConfig);
    console.log(`${pc.bold(result.boundaryId)} ${result.verdict === 'HELD' ? pc.green(result.verdict) : pc.red(result.verdict)}`);
  });

program
  .command('replay')
  .description('Replay locked boundaries at 0 credits (mock)')
  .action(async () => {
    const ratchet = createRatchet();
    await ratchet.lock(mockBoundary, await createEngine().runBoundary(mockBoundary, mockIdentities, mockConfig));
    for (const r of await ratchet.replay(mockIdentities)) console.log(`${r.boundaryId} ${r.verdict}`);
  });

program
  .command('report')
  .description('Write a report (mock)')
  .option('-o, --out <dir>', 'output directory', '.notyours/runs')
  .action((opts: { out: string }) => {
    console.log(createReport().write([], opts.out));
  });

await program.parseAsync();
