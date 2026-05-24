import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeConfig } from '../config.js';
import { finding, pass, type ProbeCheck, type ProbeSeverity } from '../report.js';

type AuditAdvisory = {
  source: string;
  packageName: string;
  title: string;
  severity: ProbeSeverity;
  vulnerableVersions?: string;
  patchedVersions?: string;
  url?: string;
  paths: string[];
  workspacePackages: string[];
  featureAreas: string[];
};

type WorkspacePackage = {
  name: string;
  path: string;
  dependencies: Record<string, string>;
};

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  medium: 2,
  high: 3,
  critical: 4,
};

const FEATURE_MAP: Array<{ test: RegExp; area: string }> = [
  { test: /^(ws|y-websocket|yjs|y-protocols|lib0)$/, area: 'WebSocket collaboration' },
  { test: /^(express|cookie|cookie-parser|express-session|csrf-sync|helmet|cors|express-rate-limit|openid-client|bcryptjs|uuid|zod)$/, area: 'API auth/security middleware' },
  { test: /^(pg)$/, area: 'PostgreSQL backend' },
  { test: /^@aws-sdk\//, area: 'AWS integrations and secrets/files' },
  { test: /^@tiptap\/|^(react|react-dom|react-router-dom|vite|@vitejs\/plugin-react|lowlight|tippy\.js|cmdk)$/, area: 'Frontend/editor experience' },
  { test: /^(testcontainers|@playwright\/test|playwright|vitest|supertest)$/, area: 'Test/runtime tooling' },
  { test: /^(typescript|tsx|prettier|husky)$/, area: 'Build/developer tooling' },
];

export async function runDependencyProbe(config: ProbeConfig): Promise<ProbeCheck[]> {
  const auditResult = await runPnpmAudit(config.repoRoot, config.timeoutMs);
  if (!auditResult.json) {
    return [finding(
      'dependencies.audit.execution',
      'pnpm audit did not produce parseable JSON',
      'dependencies',
      'medium',
      {
        exitCode: auditResult.exitCode,
        stdoutPreview: auditResult.stdout.slice(0, 2000),
        stderrPreview: auditResult.stderr.slice(0, 2000),
      },
      ['Run `pnpm audit --json` from the repository root.']
    )];
  }

  const workspacePackages = await readWorkspacePackages(config.repoRoot);
  const advisories = extractAdvisories(auditResult.json, workspacePackages);
  const highCritical = advisories.filter((advisory) => advisory.severity === 'high' || advisory.severity === 'critical');

  if (highCritical.length === 0) {
    return [pass(
      'dependencies.audit.high_critical',
      'No high or critical dependency advisories found',
      'dependencies',
      {
        exitCode: auditResult.exitCode,
        advisoryCount: advisories.length,
        highCriticalCount: 0,
        severities: countSeverities(advisories),
      },
      ['Run `pnpm audit --json` from the repository root.']
    )];
  }

  const severity = highCritical.some((advisory) => advisory.severity === 'critical') ? 'critical' : 'high';
  return [finding(
    'dependencies.audit.high_critical',
    'High or critical dependency advisories found',
    'dependencies',
    severity,
    {
      exitCode: auditResult.exitCode,
      highCriticalCount: highCritical.length,
      advisories: highCritical,
      severities: countSeverities(advisories),
    },
    [
      'Run `pnpm audit --json` from the repository root.',
      'Review each high/critical advisory package, affected workspace package, and mapped feature area.',
    ]
  )];
}

function runPnpmAudit(repoRoot: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string; json?: unknown }> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['audit', '--json'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        child.kill('SIGTERM');
      }
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (exitCode) => {
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr, json: parseJson(stdout) });
    });
    child.on('error', (error) => {
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: null, stdout, stderr: stderr + error.message });
    });
  });
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

async function readWorkspacePackages(repoRoot: string): Promise<WorkspacePackage[]> {
  const packagePaths = [
    'package.json',
    'api/package.json',
    'web/package.json',
    'shared/package.json',
    'probe/package.json',
  ];
  const packages: WorkspacePackage[] = [];

  for (const packagePath of packagePaths) {
    try {
      const parsed = JSON.parse(await readFile(join(repoRoot, packagePath), 'utf8')) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      packages.push({
        name: parsed.name ?? packagePath,
        path: packagePath,
        dependencies: {
          ...(parsed.dependencies ?? {}),
          ...(parsed.devDependencies ?? {}),
          ...(parsed.optionalDependencies ?? {}),
          ...(parsed.peerDependencies ?? {}),
        },
      });
    } catch {
      // Missing workspace package metadata should not stop the live probe.
    }
  }

  return packages;
}

function extractAdvisories(raw: unknown, workspacePackages: WorkspacePackage[]): AuditAdvisory[] {
  const advisories: AuditAdvisory[] = [];
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};

  const advisoryRecord = record.advisories;
  if (advisoryRecord && typeof advisoryRecord === 'object') {
    for (const [source, advisory] of Object.entries(advisoryRecord as Record<string, unknown>)) {
      const normalized = normalizeNpmStyleAdvisory(source, advisory, workspacePackages);
      if (normalized) advisories.push(normalized);
    }
  }

  const vulnerabilityRecord = record.vulnerabilities;
  if (vulnerabilityRecord && typeof vulnerabilityRecord === 'object') {
    for (const [packageName, vulnerability] of Object.entries(vulnerabilityRecord as Record<string, unknown>)) {
      const normalized = normalizeVulnerability(packageName, vulnerability, workspacePackages);
      if (normalized) advisories.push(normalized);
    }
  }

  return dedupeAdvisories(advisories);
}

function normalizeNpmStyleAdvisory(source: string, advisory: unknown, workspacePackages: WorkspacePackage[]): AuditAdvisory | undefined {
  if (!advisory || typeof advisory !== 'object') return undefined;
  const data = advisory as Record<string, unknown>;
  const packageName = asString(data.module_name) ?? asString(data.name);
  const severity = normalizeSeverity(asString(data.severity));
  if (!packageName || !severity) return undefined;

  const findings = Array.isArray(data.findings) ? data.findings : [];
  const paths = findings.flatMap((finding) => {
    if (!finding || typeof finding !== 'object') return [];
    const pathsValue = (finding as Record<string, unknown>).paths;
    return Array.isArray(pathsValue) ? pathsValue.filter((path): path is string => typeof path === 'string') : [];
  });

  return enrichAdvisory({
    source,
    packageName,
    title: asString(data.title) ?? packageName,
    severity,
    vulnerableVersions: asString(data.vulnerable_versions),
    patchedVersions: asString(data.patched_versions),
    url: asString(data.url),
    paths,
  }, workspacePackages);
}

function normalizeVulnerability(packageName: string, vulnerability: unknown, workspacePackages: WorkspacePackage[]): AuditAdvisory | undefined {
  if (!vulnerability || typeof vulnerability !== 'object') return undefined;
  const data = vulnerability as Record<string, unknown>;
  const severity = normalizeSeverity(asString(data.severity));
  if (!severity) return undefined;

  const via = Array.isArray(data.via) ? data.via : [];
  const advisoryVia = via.find((entry) => entry && typeof entry === 'object') as Record<string, unknown> | undefined;

  return enrichAdvisory({
    source: String(asString(advisoryVia?.source) ?? packageName),
    packageName,
    title: asString(advisoryVia?.title) ?? asString(data.title) ?? packageName,
    severity,
    vulnerableVersions: asString(data.range),
    patchedVersions: undefined,
    url: asString(advisoryVia?.url),
    paths: collectVulnerabilityPaths(packageName, data),
  }, workspacePackages);
}

function collectVulnerabilityPaths(packageName: string, vulnerability: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  paths.add(packageName);
  const effects = vulnerability.effects;
  if (Array.isArray(effects)) {
    for (const effect of effects) {
      if (typeof effect === 'string') paths.add(`${effect}>${packageName}`);
    }
  }
  const nodes = vulnerability.nodes;
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (typeof node === 'string') paths.add(node);
    }
  }
  return [...paths];
}

function enrichAdvisory(
  advisory: Omit<AuditAdvisory, 'workspacePackages' | 'featureAreas'>,
  workspacePackages: WorkspacePackage[]
): AuditAdvisory {
  return {
    ...advisory,
    paths: advisory.paths.length > 0 ? advisory.paths : [advisory.packageName],
    workspacePackages: mapWorkspacePackages(advisory.packageName, advisory.paths, workspacePackages),
    featureAreas: mapFeatureAreas(advisory.packageName, advisory.paths),
  };
}

function mapWorkspacePackages(packageName: string, paths: string[], workspacePackages: WorkspacePackage[]): string[] {
  const matches = new Set<string>();
  for (const workspacePackage of workspacePackages) {
    if (workspacePackage.dependencies[packageName]) matches.add(`${workspacePackage.name} (${workspacePackage.path})`);
    for (const path of paths) {
      for (const dependency of Object.keys(workspacePackage.dependencies)) {
        if (path === dependency || path.startsWith(`${dependency}>`) || path.includes(`>${dependency}>`)) {
          matches.add(`${workspacePackage.name} (${workspacePackage.path})`);
        }
      }
    }
  }
  return matches.size > 0 ? [...matches] : ['transitive or unresolved from audit output'];
}

function mapFeatureAreas(packageName: string, paths: string[]): string[] {
  const pathSegments = paths.flatMap((path) => path.split('>').map((part) => part.replace(/^node_modules\//, '')));
  const packageCandidates = [packageName, ...pathSegments];
  const areas = FEATURE_MAP
    .filter((entry) => packageCandidates.some((candidate) => entry.test.test(candidate)))
    .map((entry) => entry.area);
  return areas.length > 0 ? areas : ['Unknown feature area; inspect dependency path'];
}

function countSeverities(advisories: AuditAdvisory[]): Record<ProbeSeverity, number> {
  const counts: Record<ProbeSeverity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const advisory of advisories) counts[advisory.severity] += 1;
  return counts;
}

function dedupeAdvisories(advisories: AuditAdvisory[]): AuditAdvisory[] {
  const seen = new Set<string>();
  return advisories.filter((advisory) => {
    const key = `${advisory.source}:${advisory.packageName}:${advisory.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSeverity(value: string | undefined): ProbeSeverity | undefined {
  if (!value) return undefined;
  const normalized = value === 'moderate' ? 'medium' : value;
  if (!(normalized in SEVERITY_RANK)) return undefined;
  return normalized as ProbeSeverity;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
