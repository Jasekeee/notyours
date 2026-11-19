#!/usr/bin/env node
// notyours CLI entry. Checks the Node version before loading anything that might need Node 22.
const MIN_NODE = 22;
const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE) {
  console.error(
    `notyours requires Node ${MIN_NODE}+ (found ${process.versions.node}).\n` +
      `Upgrade: \`nvm install ${MIN_NODE}\` (or \`fnm install ${MIN_NODE}\`, or https://nodejs.org), then rerun.`,
  );
  process.exit(1);
}

const [{ buildProgram }, { actions }, { UserError }, { SymlinkError }, pc] = await Promise.all([
  import('./program.js'),
  import('./commands.js'),
  import('./workspace.js'),
  import('./safe-fs.js'),
  import('picocolors').then((m) => m.default),
]);

const debug = process.argv.includes('--debug');
// Kane progress lines for people watching a terminal; never for `hook` (its stderr is what the agent reads).
if (process.argv[2] !== 'hook') {
  const { setProgress } = await import('../shared/progress.js');
  setProgress((line) => console.error(pc.dim(line)));
}
try {
  await buildProgram(actions).parseAsync(process.argv);
} catch (e) {
  const err = e as Error;
  if (err instanceof UserError || err instanceof SymlinkError) {
    console.error(pc.red(`✗ ${err.message}`));
  } else {
    console.error(pc.red(`✗ ${err.message}`));
    if (debug) console.error(err.stack);
    else console.error(pc.dim('(rerun with --debug for details)'));
  }
  process.exitCode = 2;
}
