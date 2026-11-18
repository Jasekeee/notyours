#!/usr/bin/env node
// Stand-in for kane-cli in unit tests (no credits). Behaviour is driven by FAKE_KANE_* env vars.
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === 'balance') {
  console.log(`\nUpdate available: 0.10.0 → 0.10.6\n\nAvailable credits: ${process.env.FAKE_KANE_BALANCE ?? '1000'}`);
  process.exit(0);
}
const varsFile = args[args.indexOf('--variables-file') + 1];
const vars = JSON.parse(readFileSync(varsFile, 'utf8'));
const mode = (statSync(varsFile).mode & 0o777).toString(8);
console.log(JSON.stringify({ type: 'stream_start', v: 1 }));
const debug = { varsFile, mode, varNames: Object.keys(vars), passwordSecret: vars.password?.secret ?? null, cdp: args[args.indexOf('--cdp-endpoint') + 1], timeout: args[args.indexOf('--timeout') + 1], agent: args.includes('--agent'), name: args.includes('--name') ? args[args.indexOf('--name') + 1] : null };
if (process.env.FAKE_KANE_DEBUG) writeFileSync(process.env.FAKE_KANE_DEBUG, JSON.stringify(debug));
const exit = Number(process.env.FAKE_KANE_EXIT ?? '0');
if (process.env.FAKE_KANE_NO_RUN_END !== '1') {
  console.log(JSON.stringify({
    type: 'run_end',
    status: exit === 0 ? 'passed' : 'failed',
    summary: process.env.FAKE_KANE_SUMMARY ?? 'done',
    one_liner: 'fake run',
    reason_code: exit === 0 ? 'success.complete' : 'stuck.ap_stuck',
    duration: 1.5,
    credits_consumed: 12.5,
    final_state: {},
    context: { variables: { item_url: { value: 'http://127.0.0.1:1/notes/1' }, empty: { value: '' } } },
  }));
}
process.exit(exit);
