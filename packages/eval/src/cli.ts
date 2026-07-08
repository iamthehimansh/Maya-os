#!/usr/bin/env node
/**
 * `maya-eval` — run a task suite through the real Loop and print pass-rate +
 * an honesty (fake-success) score.
 *
 *   maya-eval <suite.json> [--orchestrator URL] [--admin-token TOKEN]
 *             [--lead MODEL] [--worker MODEL] [--json] [--out FILE]
 *             [--keep] [--timeout MS]
 *
 * Exit codes: 0 = suite ran; 2 = a fake success occurred (CI gate — a green
 * pass-rate must never mask the loop lying); 1 = usage/setup error.
 */

import { writeFileSync } from 'node:fs';
import { loadSuite } from './runner.js';
import { runSuite } from './runner.js';
import { renderJson, renderReport } from './report.js';
import { HttpLoopRunner } from './loop-client.js';
import type { ResolvedTask, RunKnobs } from './spec.js';
import type { TaskScore } from './scorer.js';

interface Args {
  suite?: string;
  orchestrator: string;
  adminToken?: string;
  lead?: string;
  worker?: string;
  json: boolean;
  out?: string;
  keep: boolean;
  timeoutMs?: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { orchestrator: process.env.MAYA_ORCHESTRATOR_URL ?? 'http://127.0.0.1:4400', json: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) fatal(`missing value for ${arg}`);
      return v!;
    };
    switch (arg) {
      case '--orchestrator':
      case '-o':
        a.orchestrator = next();
        break;
      case '--admin-token':
        a.adminToken = next();
        break;
      case '--lead':
        a.lead = next();
        break;
      case '--worker':
        a.worker = next();
        break;
      case '--json':
        a.json = true;
        break;
      case '--out':
        a.out = next();
        break;
      case '--keep':
        a.keep = true;
        break;
      case '--timeout':
        a.timeoutMs = Number(next());
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) fatal(`unknown flag ${arg}`);
        if (a.suite) fatal('more than one suite path given');
        a.suite = arg;
    }
  }
  if (!a.suite) fatal('a suite path is required — usage: maya-eval <suite.json> [flags]');
  return a;
}

function fatal(msg: string): never {
  process.stderr.write(`maya-eval: ${msg}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write(
    [
      'maya-eval <suite.json> [flags]',
      '',
      'Run a task suite through the Maya Loop and score pass-rate + honesty.',
      '',
      'Flags:',
      '  -o, --orchestrator URL   orchestrator base URL (default $MAYA_ORCHESTRATOR_URL or http://127.0.0.1:4400)',
      '      --admin-token TOKEN  admin bearer for POST /api/loop',
      '      --lead MODEL         override lead model for all tasks',
      '      --worker MODEL       override worker model for all tasks',
      '      --json               print machine-readable JSON instead of the table',
      '      --out FILE           also write the JSON report to FILE',
      '      --keep               keep per-task workspaces for debugging',
      '      --timeout MS         per-run timeout (default 600000)',
      '',
      'Exit code 2 means at least one FAKE SUCCESS was detected.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const suite = loadSuite(args.suite!);

  // CLI model overrides win over suite defaults/per-task values.
  const override: RunKnobs = {};
  if (args.lead) override.leadModel = args.lead;
  if (args.worker) override.workerModel = args.worker;
  if (override.leadModel || override.workerModel) {
    suite.defaults = { ...suite.defaults, ...override };
    for (const t of suite.tasks) {
      if (override.leadModel) t.leadModel = override.leadModel;
      if (override.workerModel) t.workerModel = override.workerModel;
    }
  }

  const http = new HttpLoopRunner({
    orchestratorUrl: args.orchestrator,
    ...(args.adminToken !== undefined ? { adminToken: args.adminToken } : {}),
    ...(args.timeoutMs !== undefined ? { runTimeoutMs: args.timeoutMs } : {}),
  });
  if (!(await http.health())) {
    fatal(`orchestrator not reachable at ${args.orchestrator} — start it with \`maya serve\` (or pass --orchestrator).`);
  }

  process.stderr.write(`▶ running ${suite.tasks.length} task(s) against ${args.orchestrator}\n`);
  const score = await runSuite(suite, {
    runner: http.run,
    keepWorkspaces: args.keep,
    onTaskStart: (t: ResolvedTask, i, n) => process.stderr.write(`  [${i + 1}/${n}] ${t.id} … `),
    onTaskDone: (s: TaskScore, _i, _n) =>
      process.stderr.write(`${s.passed ? 'pass' : 'FAIL'} (reported ${s.reported}${s.label === 'fake-success' ? ' 🚨 FAKE' : ''})\n`),
  });

  const json = renderJson(score, { name: suite.name });
  if (args.out) writeFileSync(args.out, json);
  process.stdout.write(args.json ? json + '\n' : renderReport(score, { name: suite.name }) + '\n');

  process.exit(score.fakeSuccess > 0 ? 2 : 0);
}

main().catch((err) => fatal(String(err instanceof Error ? err.stack ?? err.message : err)));
