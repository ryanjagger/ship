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

const SURFACE_ORDER: ProbeSurface[] = [
  'preflight',
  'auth',
  'websocket',
  'dependencies',
  'inputs',
  'headers',
  'secrets',
  'rate-limit',
  'runner',
];

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
    onlyGroups: string[];
    skipGroups: string[];
    aggressiveRateLimit: boolean;
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
  const redactedChecks = checks.map(redactCheck);
  const bySeverity: Record<ProbeSeverity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  for (const check of redactedChecks) {
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
      onlyGroups: config.onlyGroups,
      skipGroups: config.skipGroups,
      aggressiveRateLimit: config.aggressiveRateLimit,
    },
    summary: {
      total: redactedChecks.length,
      passed: redactedChecks.filter((check) => check.status === 'pass').length,
      findings: redactedChecks.filter((check) => check.status === 'finding').length,
      notTested: redactedChecks.filter((check) => check.status === 'not-tested').length,
      bySeverity,
    },
    checks: redactedChecks,
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
  lines.push(`- Aggressive rate-limit mode: \`${report.config.aggressiveRateLimit ? 'enabled' : 'disabled'}\``);
  if (report.config.onlyGroups.length > 0) lines.push(`- Only groups: \`${report.config.onlyGroups.join(', ')}\``);
  if (report.config.skipGroups.length > 0) lines.push(`- Skipped groups: \`${report.config.skipGroups.join(', ')}\``);
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

  lines.push('## Surface Summary');
  lines.push('');
  lines.push('| Surface | Findings | Not tested | Passed |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const summary of summarizeBySurface(report)) {
    lines.push(`| ${summary.surface} | ${summary.findings} | ${summary.notTested} | ${summary.passed} |`);
  }
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

function summarizeBySurface(report: ProbeReport): Array<{ surface: ProbeSurface; findings: number; notTested: number; passed: number }> {
  const summaries = new Map<ProbeSurface, { surface: ProbeSurface; findings: number; notTested: number; passed: number }>();

  for (const check of report.checks) {
    const current = summaries.get(check.surface) ?? { surface: check.surface, findings: 0, notTested: 0, passed: 0 };
    if (check.status === 'finding') current.findings += 1;
    if (check.status === 'not-tested') current.notTested += 1;
    if (check.status === 'pass') current.passed += 1;
    summaries.set(check.surface, current);
  }

  return [...summaries.values()].sort((a, b) => SURFACE_ORDER.indexOf(a.surface) - SURFACE_ORDER.indexOf(b.surface));
}

function redactCheck(check: ProbeCheck): ProbeCheck {
  return {
    ...check,
    evidence: redactValue(check.evidence),
  };
}

function redactValue(value: unknown, key = ''): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (isSensitiveKey(key)) return '[redacted]';
    return redactString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return isSensitiveKey(key) ? '[redacted]' : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, key));
  }

  if (typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      redacted[entryKey] = redactValue(entryValue, entryKey);
    }
    return redacted;
  }

  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return [
    'password',
    'authorization',
    'cookie',
    'setcookie',
    'sessionid',
    'csrftoken',
    'csrf',
    'token',
    'apitoken',
    'accesstoken',
    'refreshtoken',
    'secret',
    'apikey',
    'accesskey',
    'privatekey',
    'databaseurl',
  ].includes(normalized);
}

function redactString(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^"'\s<>)]+/gi, '[redacted:database-url]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[redacted:aws-access-key]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted:jwt]')
    .replace(/session_id=[^;\s"']+/gi, 'session_id=[redacted]')
    .replace(/("(?:password|token|csrfToken|apiToken|secret|authorization)"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2');
}
