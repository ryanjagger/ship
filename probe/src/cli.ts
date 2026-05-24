#!/usr/bin/env node

import open from 'open';
import { PROBE_GROUPS, parseConfig, shouldRunInteractive, type ProbeConfig, type ProbeGroup } from './config.js';
import { createReport, finding, writeReports, type ProbeCheck } from './report.js';
import { promptForConfig } from './prompts.js';
import { runPreflightProbe } from './probes/preflight.js';
import { runAuthProbe } from './probes/auth.js';
import { runWebSocketProbe } from './probes/websocket.js';
import { runDependencyProbe } from './probes/dependencies.js';
import { runInputProbe } from './probes/inputs.js';
import { runHeadersProbe } from './probes/headers.js';
import { runRateLimitProbe } from './probes/rate-limit.js';

type ProbeRunner = {
  group: ProbeGroup;
  errorId: string;
  errorTitle: string;
  run: (config: ProbeConfig) => Promise<ProbeCheck[]>;
};

const PROBE_RUNNERS: ProbeRunner[] = [
  {
    group: 'preflight',
    errorId: 'runner.preflight_probe.unhandled_error',
    errorTitle: 'Preflight probe crashed before completion',
    run: runPreflightProbe,
  },
  {
    group: 'auth',
    errorId: 'runner.auth_probe.unhandled_error',
    errorTitle: 'Auth probe crashed before completion',
    run: runAuthProbe,
  },
  {
    group: 'websocket',
    errorId: 'runner.websocket_probe.unhandled_error',
    errorTitle: 'WebSocket probe crashed before completion',
    run: runWebSocketProbe,
  },
  {
    group: 'dependencies',
    errorId: 'runner.dependencies_probe.unhandled_error',
    errorTitle: 'Dependency probe crashed before completion',
    run: runDependencyProbe,
  },
  {
    group: 'inputs',
    errorId: 'runner.inputs_probe.unhandled_error',
    errorTitle: 'Input sanitization probe crashed before completion',
    run: runInputProbe,
  },
  {
    group: 'headers',
    errorId: 'runner.headers_probe.unhandled_error',
    errorTitle: 'Headers, verbose-error, or secrets probe crashed before completion',
    run: runHeadersProbe,
  },
  {
    group: 'rate-limit',
    errorId: 'runner.rate_limit_probe.unhandled_error',
    errorTitle: 'Rate-limit probe crashed before completion',
    run: runRateLimitProbe,
  },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const interactive = shouldRunInteractive(argv);
  const config = interactive ? await promptForConfig(parseConfig([])) : parseConfig(argv);
  const checks: ProbeCheck[] = [];
  const activeGroups = PROBE_RUNNERS
    .filter((runner) => shouldRunGroup(config, runner.group))
    .map((runner) => runner.group);

  for (const runner of PROBE_RUNNERS) {
    if (!activeGroups.includes(runner.group)) continue;
    try {
      checks.push(...await runner.run(config));
    } catch (error) {
      checks.push(finding(
        runner.errorId,
        runner.errorTitle,
        'runner',
        'critical',
        {
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
        ['Run `pnpm probe` again and inspect this stack trace.']
      ));
    }
  }

  const report = createReport(config, checks);
  const paths = await writeReports(config, report);

  console.log(`Probe complete. Findings: ${report.summary.findings}; not tested: ${report.summary.notTested}; passed: ${report.summary.passed}.`);
  console.log(`Groups: ${activeGroups.length > 0 ? activeGroups.join(', ') : 'none'}`);
  if (config.onlyGroups.length > 0) console.log(`Only: ${config.onlyGroups.join(', ')}`);
  if (config.skipGroups.length > 0) console.log(`Skipped: ${config.skipGroups.join(', ')}`);
  if (config.aggressiveRateLimit) console.log('Aggressive rate-limit mode: enabled');
  console.log('By surface:');
  for (const summary of summarizeBySurface(checks)) {
    console.log(`  ${summary.surface}: ${summary.findings} finding(s), ${summary.notTested} not tested, ${summary.passed} passed`);
  }
  console.log(`Run JSON: ${paths.runJsonPath}`);
  console.log(`Run Markdown: ${paths.runMarkdownPath}`);
  console.log(`HTML: ${paths.runHtmlPath}`);
  console.log(`Index: ${paths.indexPath}`);
  console.log(`JSON: ${paths.jsonPath}`);
  console.log(`Markdown: ${paths.markdownPath}`);

  await maybeOpenReport(interactive, paths.runHtmlPath, process.stdout.isTTY ?? false);
}

/**
 * Open the report HTML in the default browser when the run was interactive AND
 * stdout is a TTY. Anything else (CI, scripted, non-TTY) is a no-op. Browser-
 * open failures are non-fatal — log a soft warning, never crash the run.
 */
export async function maybeOpenReport(
  interactive: boolean,
  htmlPath: string,
  stdoutIsTTY: boolean,
  openImpl: (target: string) => Promise<unknown> = open
): Promise<void> {
  if (!interactive || !stdoutIsTTY) return;
  try {
    await openImpl(htmlPath);
  } catch (error) {
    console.warn(`Could not open browser automatically — open ${htmlPath} manually (${(error as Error).message})`);
  }
}

function shouldRunGroup(config: ProbeConfig, group: ProbeGroup): boolean {
  if (config.onlyGroups.length > 0 && !config.onlyGroups.includes(group)) return false;
  return !config.skipGroups.includes(group);
}

function summarizeBySurface(checks: ProbeCheck[]): Array<{ surface: string; findings: number; notTested: number; passed: number }> {
  const order = [...PROBE_GROUPS, 'secrets', 'runner'];
  const summaries = new Map<string, { surface: string; findings: number; notTested: number; passed: number }>();

  for (const check of checks) {
    const current = summaries.get(check.surface) ?? { surface: check.surface, findings: 0, notTested: 0, passed: 0 };
    if (check.status === 'finding') current.findings += 1;
    if (check.status === 'not-tested') current.notTested += 1;
    if (check.status === 'pass') current.passed += 1;
    summaries.set(check.surface, current);
  }

  return [...summaries.values()].sort((a, b) => order.indexOf(a.surface) - order.indexOf(b.surface));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(0);
});
