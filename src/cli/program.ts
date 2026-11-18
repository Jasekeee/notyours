// Command-line surface. Handlers are injected so argument parsing is testable without side effects.
import { Argument, Command, Option } from 'commander';
import pkg from '../../package.json' with { type: 'json' };

export interface GlobalOpts {
  /** Project directory (default: current directory). */
  cwd: string;
}

export const HOOK_EVENTS = ['post-tool', 'guard', 'stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface InitOpts extends GlobalOpts {
  url: string;
  users?: string;
  allowHost: string[];
  iOwnThis: boolean;
}
export interface RunOpts extends GlobalOpts {
  dryRun: boolean;
}
export interface LockOpts extends GlobalOpts {
  reauthor: boolean;
}
export interface ReportOpts extends GlobalOpts {
  open: boolean;
}
export interface DemoOpts extends GlobalOpts {
  dir?: string;
  open: boolean;
  /** Only B1 (Bob opens Alice's note): one real leak, the fastest real run. */
  quick?: boolean;
}
export interface InstallHooksOpts extends GlobalOpts {
  cli: string;
}

/** Each handler returns the process exit code. */
export interface Actions {
  doctor(o: GlobalOpts): Promise<number>;
  init(o: InitOpts): Promise<number>;
  map(o: GlobalOpts): Promise<number>;
  run(ids: string[], o: RunOpts): Promise<number>;
  lock(ids: string[], o: LockOpts): Promise<number>;
  replay(ids: string[], o: GlobalOpts): Promise<number>;
  report(o: ReportOpts): Promise<number>;
  demo(o: DemoOpts): Promise<number>;
  installHooks(o: InstallHooksOpts): Promise<number>;
  hook(event: HookEvent, o: GlobalOpts): Promise<number>;
  budget(o: BudgetOpts): Promise<number>;
}

export interface BudgetOpts extends GlobalOpts {
  /** New daily cap on authoring Kane runs (a person only). */
  set?: number;
}

export const DEFAULT_HOOK_CLI = 'npx notyours';

const collect = (v: string, prev: string[]) => [...prev, v];

export interface BuildOptions {
  onExit?: (code: number) => void;
  /** Throw CommanderError instead of exiting, and silence commander's output (tests). */
  testing?: boolean;
}

export function buildProgram(actions: Actions, { onExit = (c) => void (process.exitCode = c), testing = false }: BuildOptions = {}): Command {
  const program = new Command();
  // Set before subcommands are added so they inherit it.
  if (testing) program.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  program
    .name('notyours')
    .description(`${pkg.description}\nNot a pentest tool: isolation tests for your own app.`)
    .version(pkg.version)
    .option('-C, --cwd <dir>', 'project directory (default: current directory)')
    .showHelpAfterError('(run `notyours --help` for usage)');

  const g = (cmd: Command): GlobalOpts => ({ cwd: (cmd.optsWithGlobals() as { cwd?: string }).cwd ?? process.cwd() });
  const done = async (p: Promise<number>) => onExit(await p);

  program
    .command('doctor')
    .description('check Node 22+, Chrome, kane-cli login and credits, port 3077')
    .action(async (_o, cmd: Command) => done(actions.doctor(g(cmd))));

  program
    .command('init')
    .description('set up .notyours/ for an app you own (localhost by default)')
    .requiredOption('--url <url>', 'base URL of your app, e.g. http://localhost:3000')
    .option('--users <file>', 'YAML/JSON list of test users: id, role, plan, email, password|passwordEnv')
    .option('--allow-host <host>', 'add a non-local host to allowHosts (repeatable; needs --i-own-this)', collect, [])
    .option('--i-own-this', 'confirm you own the non-local host and may test it', false)
    .action(async (o: { url: string; users?: string; allowHost: string[]; iOwnThis: boolean }, cmd: Command) =>
      done(actions.init({ ...g(cmd), url: o.url, users: o.users, allowHost: o.allowHost, iOwnThis: o.iOwnThis })),
    );

  program
    .command('map')
    .description('scan Express/Next.js routes and draft boundaries (static, no AI, no credits)')
    .action(async (_o, cmd: Command) => done(actions.map(g(cmd))));

  program
    .command('run')
    .description('prove boundaries with Kane personas (authoring: ~30 credits per boundary)')
    .argument('[ids...]', 'boundary ids (default: all)')
    .option('--dry-run', 'validate boundaries and print the plan and credit estimate; start nothing', false)
    .action(async (ids: string[], o: { dryRun: boolean }, cmd: Command) => done(actions.run(ids, { ...g(cmd), dryRun: o.dryRun })));

  program
    .command('lock')
    .description('lock proven boundaries into replayable tests (replays cost 0 credits)')
    .argument('[ids...]', 'boundary ids (default: all)')
    .option('--reauthor', 'record the test again with a fresh authoring run (~30 credits each)', false)
    .action(async (ids: string[], o: { reauthor: boolean }, cmd: Command) => done(actions.lock(ids, { ...g(cmd), reauthor: o.reauthor })));

  program
    .command('replay')
    .description('replay locked boundaries (0 credits, about a second each)')
    .argument('[ids...]', 'boundary ids (default: all locked)')
    .action(async (ids: string[], _o, cmd: Command) => done(actions.replay(ids, g(cmd))));

  program
    .command('budget')
    .description("show today's authoring Kane runs vs the daily cap; --set N raises it (a person only, not an agent)")
    .option('--set <n>', 'new daily cap on authoring Kane runs (default 20)', (v) => Number(v))
    .action(async (o: { set?: number }, cmd: Command) => done(actions.budget({ ...g(cmd), ...(o.set !== undefined ? { set: o.set } : {}) })));

  program
    .command('report')
    .description('write the HTML + JSON report for the latest run')
    .option('--open', 'open the report in your browser', false)
    .action(async (o: { open: boolean }, cmd: Command) => done(actions.report({ ...g(cmd), open: o.open })));

  program
    .command('demo')
    .description('run the bundled demo app on :3077 and probe it end to end')
    .option('--dir <dir>', 'working directory to reuse (keeps recordings, so reruns replay for 0 credits)')
    .option('--no-open', 'do not open the report')
    .option('--quick', "only B1 (Bob opens Alice's note): one real leak in ~4 min")
    .action(async (o: { dir?: string; open: boolean; quick?: boolean }, cmd: Command) => done(actions.demo({ ...g(cmd), dir: o.dir, open: o.open, quick: o.quick === true })));

  program
    .command('install-hooks')
    .description('add notyours hooks (guard, post-tool, stop) and /notyours-map to .claude/')
    .option('--cli <command>', 'command Claude Code runs to call notyours', DEFAULT_HOOK_CLI)
    .action(async (o: { cli: string }, cmd: Command) => done(actions.installHooks({ ...g(cmd), cli: o.cli })));

  program
    .command('hook')
    .description('Claude Code hook entry point (reads the hook JSON on stdin)')
    .addArgument(new Argument('<event>', 'hook event').choices(HOOK_EVENTS))
    .action(async (event: HookEvent, _o, cmd: Command) => done(actions.hook(event, g(cmd))));

  program.addOption(new Option('--debug', 'print stack traces on errors').hideHelp());
  return program;
}
