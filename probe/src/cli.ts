#!/usr/bin/env node

import { parseConfig } from './config.js';
import { createReport, finding, notTested, writeReports, type ProbeCheck } from './report.js';
import { runAuthProbe } from './probes/auth.js';
import { runWebSocketProbe } from './probes/websocket.js';

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

  checks.push(...placeholderChecks());

  const report = createReport(config, checks);
  const paths = await writeReports(config, report);

  console.log(`Probe complete. Findings: ${report.summary.findings}; not tested: ${report.summary.notTested}; passed: ${report.summary.passed}.`);
  console.log(`JSON: ${paths.jsonPath}`);
  console.log(`Markdown: ${paths.markdownPath}`);
}

function placeholderChecks(): ProbeCheck[] {
  return [
    notTested('inputs.sanitization.not_implemented', 'Input sanitization probes are not implemented in this slice', 'inputs', {
      plannedVectors: ['stored-xss', 'reflected-xss', 'sql-injection', 'long-input'],
    }),
    notTested('dependencies.audit.not_implemented', 'Dependency vulnerability probes are not implemented in this slice', 'dependencies', {
      plannedCommand: 'pnpm audit --json',
    }),
    notTested('headers.cors_csp.not_implemented', 'CORS/CSP and verbose-error probes are not implemented in this slice', 'headers', {
      plannedChecks: ['cors-origin', 'content-security-policy', 'stack-trace-leakage'],
    }),
    notTested('secrets.live_http.not_implemented', 'Live HTTP secrets exposure probes are not implemented in this slice', 'secrets', {
      plannedPaths: ['/.env', '/api/.env', '/config.json', '/assets/*.map'],
    }),
    notTested('rate_limit.default.not_implemented', 'Rate-limit probes are not implemented in this slice', 'rate-limit', {
      plannedMode: 'production-safe low-volume checks by default',
    }),
  ];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(0);
});
