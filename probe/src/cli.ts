#!/usr/bin/env node

import { parseConfig } from './config.js';
import { createReport, finding, notTested, writeReports, type ProbeCheck } from './report.js';
import { runAuthProbe } from './probes/auth.js';
import { runWebSocketProbe } from './probes/websocket.js';
import { runDependencyProbe } from './probes/dependencies.js';
import { runInputProbe } from './probes/inputs.js';
import { runHeadersProbe } from './probes/headers.js';

async function main(): Promise<void> {
  const config = parseConfig();
  const checks: ProbeCheck[] = [];

  try {
    checks.push(...await runAuthProbe(config));
  } catch (error) {
    checks.push(finding(
      'runner.auth_probe.unhandled_error',
      'Auth probe crashed before completion',
      'runner',
      'critical',
      {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
      ['Run the probe command again with the same arguments and inspect this stack trace.']
    ));
  }

  try {
    checks.push(...await runWebSocketProbe(config));
  } catch (error) {
    checks.push(finding(
      'runner.websocket_probe.unhandled_error',
      'WebSocket probe crashed before completion',
      'runner',
      'critical',
      {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
      ['Run the probe command again with the same arguments and inspect this stack trace.']
    ));
  }

  try {
    checks.push(...await runDependencyProbe(config));
  } catch (error) {
    checks.push(finding(
      'runner.dependencies_probe.unhandled_error',
      'Dependency probe crashed before completion',
      'runner',
      'critical',
      {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
      ['Run `pnpm probe` again and inspect this stack trace.']
    ));
  }

  try {
    checks.push(...await runInputProbe(config));
  } catch (error) {
    checks.push(finding(
      'runner.inputs_probe.unhandled_error',
      'Input sanitization probe crashed before completion',
      'runner',
      'critical',
      {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
      ['Run `pnpm probe` again and inspect this stack trace.']
    ));
  }

  try {
    checks.push(...await runHeadersProbe(config));
  } catch (error) {
    checks.push(finding(
      'runner.headers_probe.unhandled_error',
      'Headers, verbose-error, or secrets probe crashed before completion',
      'runner',
      'critical',
      {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
      ['Run `pnpm probe` again and inspect this stack trace.']
    ));
  }

  checks.push(...placeholderChecks());

  const report = createReport(config, checks);
  const paths = await writeReports(config, report);

  console.log(`Probe complete. Findings: ${report.summary.findings}; not tested: ${report.summary.notTested}; passed: ${report.summary.passed}.`);
  console.log(`JSON: ${paths.jsonPath}`);
  console.log(`Markdown: ${paths.markdownPath}`);
}

function placeholderChecks(): ProbeCheck[] {
  return [
    notTested('rate_limit.default.not_implemented', 'Rate-limit probes are not implemented in this slice', 'rate-limit', {
      plannedMode: 'production-safe low-volume checks by default',
    }),
  ];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(0);
});
