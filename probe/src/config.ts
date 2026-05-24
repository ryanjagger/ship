import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const PROBE_GROUPS = [
  'preflight',
  'auth',
  'websocket',
  'dependencies',
  'inputs',
  'headers',
  'rate-limit',
] as const;

export type ProbeGroup = typeof PROBE_GROUPS[number];

export type ProbeConfig = {
  repoRoot: string;
  apiUrl: string;
  webUrl?: string;
  email: string;
  password: string;
  allowMutation: boolean;
  keepData: boolean;
  outputDir: string;
  timeoutMs: number;
  runId: string;
  databaseUrl?: string;
  onlyGroups: ProbeGroup[];
  skipGroups: ProbeGroup[];
  aggressiveRateLimit: boolean;
};

const DEFAULT_API_URL = 'http://localhost:3000';
const DEFAULT_EMAIL = 'dev@ship.local';
const DEFAULT_PASSWORD = 'admin123';
const DEFAULT_TIMEOUT_MS = 30_000;

function readValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function readValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value && !value.startsWith('--')) values.push(value);
  }
  return values;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function parseConfig(argv: string[] = process.argv.slice(2)): ProbeConfig {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const repoRoot = findRepoRoot(process.cwd());
  const apiUrl = normalizeBaseUrl(readValue(argv, '--api-url') ?? process.env.PROBE_API_URL ?? DEFAULT_API_URL);
  const webUrlRaw = readValue(argv, '--web-url') ?? process.env.PROBE_WEB_URL;
  const outputDir = resolve(repoRoot, readValue(argv, '--output-dir') ?? process.env.PROBE_OUTPUT_DIR ?? 'probe/results');
  const timeoutValue = Number(readValue(argv, '--timeout-ms') ?? process.env.PROBE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const onlyGroups = parseProbeGroups([...readValues(argv, '--only'), process.env.PROBE_ONLY ?? ''].filter(Boolean), '--only');
  const skipGroups = parseProbeGroups([...readValues(argv, '--skip'), process.env.PROBE_SKIP ?? ''].filter(Boolean), '--skip');

  return {
    repoRoot,
    apiUrl,
    webUrl: webUrlRaw ? normalizeBaseUrl(webUrlRaw) : undefined,
    email: readValue(argv, '--email') ?? process.env.PROBE_EMAIL ?? DEFAULT_EMAIL,
    password: readValue(argv, '--password') ?? process.env.PROBE_PASSWORD ?? DEFAULT_PASSWORD,
    allowMutation: argv.includes('--allow-mutation') || process.env.PROBE_ALLOW_MUTATION === '1',
    keepData: argv.includes('--keep-data') || process.env.PROBE_KEEP_DATA === '1',
    outputDir,
    timeoutMs: Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : DEFAULT_TIMEOUT_MS,
    runId: readValue(argv, '--run-id') ?? `probe-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    databaseUrl: process.env.DATABASE_URL,
    onlyGroups,
    skipGroups,
    aggressiveRateLimit: argv.includes('--aggressive-rate-limit') || process.env.PROBE_AGGRESSIVE_RATE_LIMIT === '1',
  };
}

/**
 * True when the operator invoked `pnpm probe` with no CLI flags AND stdin is a TTY.
 * Any flag (anything starting with `-`) or a non-interactive stdin short-circuits to false.
 */
export function shouldRunInteractive(argv: string[] = process.argv.slice(2), stdinIsTTY: boolean | undefined = process.stdin.isTTY): boolean {
  if (!stdinIsTTY) return false;
  return !argv.some((arg) => arg.startsWith('-'));
}

/**
 * Reads the `.ports` file written by scripts/dev.sh and returns API/web URL defaults.
 * Returns `{}` when the file is absent (the dev server is not running) — never throws.
 */
export function loadPortsFile(repoRoot: string): { api?: string; web?: string } {
  const path = resolve(repoRoot, '.ports');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }

  const ports: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && value) ports[key] = value;
  }

  const result: { api?: string; web?: string } = {};
  if (ports.API) result.api = `http://localhost:${ports.API}`;
  if (ports.WEB) result.web = `http://localhost:${ports.WEB}`;
  return result;
}

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function parseProbeGroups(values: string[], flagName: string): ProbeGroup[] {
  const groups = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = groups.filter((group) => !isProbeGroup(group));

  if (invalid.length > 0) {
    console.error(`Invalid ${flagName} probe group: ${invalid.join(', ')}`);
    console.error(`Valid groups: ${PROBE_GROUPS.join(', ')}`);
    process.exit(0);
  }

  return [...new Set(groups)] as ProbeGroup[];
}

function isProbeGroup(value: string): value is ProbeGroup {
  return (PROBE_GROUPS as readonly string[]).includes(value);
}

function printHelp(): void {
  console.log(`Usage:
  pnpm probe -- --api-url http://localhost:3000 --web-url http://localhost:5173 --allow-mutation

Options:
  --api-url <url>       API base URL. Default: ${DEFAULT_API_URL}
  --web-url <url>       Optional web app base URL.
  --email <email>       Login email. Default: ${DEFAULT_EMAIL}
  --password <password> Login password. Default: ${DEFAULT_PASSWORD}
  --allow-mutation      Required for probes that create tokens, invites, users, or DB session changes.
  --aggressive-rate-limit
                        Force a 429 proof against login rate limiting. May affect reruns until the limiter resets.
  --only <groups>       Comma-separated probe groups to run. Valid: ${PROBE_GROUPS.join(', ')}
  --skip <groups>       Comma-separated probe groups to skip. Valid: ${PROBE_GROUPS.join(', ')}
  --keep-data           Keep audit-created data where cleanup is supported.
  --output-dir <dir>    Report output directory. Default: probe/results
  --timeout-ms <ms>     Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --run-id <id>         Stable run id for namespacing audit-created data.
`);
}
