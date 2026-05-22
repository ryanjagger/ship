import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeConfig } from './config.js';

export type ProbeSurface =
  | 'preflight'
  | 'auth'
  | 'websocket'
  | 'inputs'
  | 'dependencies'
  | 'headers'
  | 'secrets'
  | 'rate-limit'
  | 'runner';

export type ProbeSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type ProbeStatus = 'pass' | 'finding' | 'not-tested';

export type ProbeCheck = {
  id: string;
  title: string;
  surface: ProbeSurface;
  severity: ProbeSeverity;
  status: ProbeStatus;
  evidence?: unknown;
  reproductionSteps: string[];
};

export type ProbeReport = {
  tool: 'probe';
  generatedAt: string;
  runId: string;
  target: {
    apiUrl: string;
    webUrl?: string;
  };
  config: {
    allowMutation: boolean;
    keepData: boolean;
    databaseUrlAvailable: boolean;
  };
  summary: {
    total: number;
    passed: number;
    findings: number;
    notTested: number;
    bySeverity: Record<ProbeSeverity, number>;
  };
  checks: ProbeCheck[];
};

export function pass(
  id: string,
  title: string,
  surface: ProbeSurface,
  evidence: unknown,
  reproductionSteps: string[] = []
): ProbeCheck {
  return {
    id,
    title,
    surface,
    severity: 'info',
    status: 'pass',
    evidence,
    reproductionSteps,
  };
}

export function finding(
  id: string,
  title: string,
  surface: ProbeSurface,
  severity: Exclude<ProbeSeverity, 'info'>,
  evidence: unknown,
  reproductionSteps: string[]
): ProbeCheck {
  return {
    id,
    title,
    surface,
    severity,
    status: 'finding',
    evidence,
    reproductionSteps,
  };
}

export function notTested(
  id: string,
  title: string,
  surface: ProbeSurface,
  evidence: unknown,
  reproductionSteps: string[] = []
): ProbeCheck {
  return {
    id,
    title,
    surface,
    severity: 'info',
    status: 'not-tested',
    evidence,
    reproductionSteps,
  };
}

export function createReport(config: ProbeConfig, checks: ProbeCheck[]): ProbeReport {
  const bySeverity: Record<ProbeSeverity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  for (const check of checks) {
    if (check.status === 'finding') {
      bySeverity[check.severity] += 1;
    }
  }

  const report: ProbeReport = {
    tool: 'probe',
    generatedAt: new Date().toISOString(),
    runId: config.runId,
    target: {
      apiUrl: config.apiUrl,
      ...(config.webUrl ? { webUrl: config.webUrl } : {}),
    },
    config: {
      allowMutation: config.allowMutation,
      keepData: config.keepData,
      databaseUrlAvailable: Boolean(config.databaseUrl),
    },
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.status === 'pass').length,
      findings: checks.filter((check) => check.status === 'finding').length,
      notTested: checks.filter((check) => check.status === 'not-tested').length,
      bySeverity,
    },
    checks,
  };

  return report;
}

export async function writeReports(config: ProbeConfig, report: ProbeReport): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(config.outputDir, { recursive: true });

  const jsonPath = join(config.outputDir, 'security-report.json');
  const markdownPath = join(config.outputDir, 'security-report.md');

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');

  return { jsonPath, markdownPath };
}

export function renderMarkdown(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push('# Ship Security Probe Report');
  lines.push('');
  lines.push(`- Run ID: \`${report.runId}\``);
  lines.push(`- Generated: \`${report.generatedAt}\``);
  lines.push(`- API target: \`${report.target.apiUrl}\``);
  if (report.target.webUrl) lines.push(`- Web target: \`${report.target.webUrl}\``);
  lines.push(`- Mutating probes: \`${report.config.allowMutation ? 'enabled' : 'disabled'}\``);
  lines.push(`- DATABASE_URL available: \`${report.config.databaseUrlAvailable ? 'yes' : 'no'}\``);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Total checks | ${report.summary.total} |`);
  lines.push(`| Passed | ${report.summary.passed} |`);
  lines.push(`| Findings | ${report.summary.findings} |`);
  lines.push(`| Not tested | ${report.summary.notTested} |`);
  lines.push(`| Critical | ${report.summary.bySeverity.critical} |`);
  lines.push(`| High | ${report.summary.bySeverity.high} |`);
  lines.push(`| Medium | ${report.summary.bySeverity.medium} |`);
  lines.push(`| Low | ${report.summary.bySeverity.low} |`);
  lines.push('');

  lines.push('## Audit Deliverable');
  lines.push('');
  lines.push('| Metric | Baseline |');
  lines.push('| --- | --- |');
  lines.push('| Security probe tool | Runnable: Yes |');
  lines.push(`| Auth/session vulnerabilities found | ${summarizeFindings(report, 'auth')} |`);
  lines.push(`| WebSocket validation failures | ${summarizeFindings(report, 'websocket')} |`);
  lines.push(`| Input sanitization failures | ${summarizeFindings(report, 'inputs')} |`);
  lines.push(`| High/Critical CVEs in dependencies | ${summarizeFindings(report, 'dependencies')} |`);
  lines.push(`| CORS/CSP misconfiguration | ${summarizeFindingsByIdPrefix(report, 'headers', ['headers.cors.', 'headers.security_headers.'])} |`);
  lines.push(`| Secrets exposure risk | ${summarizeFindings(report, 'secrets')} |`);
  lines.push(`| Rate limiting absent on endpoints | ${summarizeFindings(report, 'rate-limit')} |`);
  lines.push(`| Verbose error leakage | ${summarizeFindingsByIdPrefix(report, 'headers', ['headers.verbose_errors'])} |`);
  lines.push('');

  lines.push('## Checks');
  lines.push('');
  for (const check of report.checks) {
    lines.push(`### ${check.id}`);
    lines.push('');
    lines.push(`- Title: ${check.title}`);
    lines.push(`- Surface: \`${check.surface}\``);
    lines.push(`- Status: \`${check.status}\``);
    lines.push(`- Severity: \`${check.severity}\``);
    if (check.evidence !== undefined) {
      lines.push('- Evidence:');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(check.evidence, null, 2));
      lines.push('```');
    }
    if (check.reproductionSteps.length > 0) {
      lines.push('- Reproduction steps:');
      for (const step of check.reproductionSteps) {
        lines.push(`  - ${step}`);
      }
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function summarizeFindings(report: ProbeReport, surface: ProbeSurface): string {
  const findings = report.checks.filter((check) => check.surface === surface && check.status === 'finding');
  if (findings.length === 0) return 'None found';
  return findings.map((check) => `${check.severity}: ${check.title}`).join('<br>');
}

function summarizeFindingsByIdPrefix(report: ProbeReport, surface: ProbeSurface, prefixes: string[]): string {
  const findings = report.checks.filter((check) => {
    return check.surface === surface &&
      check.status === 'finding' &&
      prefixes.some((prefix) => check.id.startsWith(prefix));
  });
  if (findings.length === 0) return 'None found';
  return findings.map((check) => `${check.severity}: ${check.title}`).join('<br>');
}
